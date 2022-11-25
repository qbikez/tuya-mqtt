import TuyAPI from "tuyapi";
import { evaluate } from "mathjs";
import utils from "../lib/utils";
import dbg from "debug";
import { DeviceInfo, DeviceTopic } from "../interfaces";
const debug = dbg("tuya-mqtt:tuyapi");
const debugState = dbg("tuya-mqtt:state");
const debugCommand = dbg("tuya-mqtt:command");
const debugError = dbg("tuya-mqtt:error");

const HEARTBEAT_MS = 10000;

export default class TuyaDevice {
  config: any;
  mqttClient: any;
  topic: string;
  discoveryTopic: string;
  options: {
    id: string;
    key: string;
    name?: string;
    ip?: string;
    version?: string;
  };
  deviceData: { ids: any[]; name: any; mf: string; mdl?: any };
  dps: Record<string, any>;
  color: { h: number; s: number; b: number };
  // eslint-disable-next-line @typescript-eslint/ban-types
  deviceTopics: Record<string, DeviceTopic>;
  heartbeatsMissed: number;
  reconnecting: boolean;
  baseTopic: string;
  device: TuyAPI;
  connected: boolean | undefined;
  isRgbtwLight: any;
  cmdColor: { h: any; s: any; b: any } = { h: 0, s: 0, b: 0 };

  constructor(deviceInfo: DeviceInfo) {
    this.config = deviceInfo.configDevice;
    this.mqttClient = deviceInfo.mqttClient;
    this.topic = deviceInfo.topic;
    this.discoveryTopic = deviceInfo.discoveryTopic;

    // Build TuyAPI device options from device config info
    this.options = {
      id: this.config.id,
      key: this.config.key,
    };
    if (this.config.name) {
      this.options.name = this.config.name
        .toLowerCase()
        .replace(/\s|\+|#|\//g, "_");
    }
    if (this.config.ip) {
      this.options.ip = this.config.ip;
      if (this.config.version) {
        this.options.version = this.config.version;
      } else {
        this.options.version = "3.1";
      }
    }

    // Set default device data for Home Assistant device registry
    // Values may be overridden by individual devices
    this.deviceData = {
      ids: [this.config.id],
      name: this.config.name ? this.config.name : this.config.id,
      mf: "Tuya",
    };

    // Initialize properties to hold cached device state data
    this.dps = {};
    this.color = { h: 0, s: 0, b: 0 };

    // Device friendly topics
    this.deviceTopics = {};

    // Missed heartbeat monitor
    this.heartbeatsMissed = 0;
    this.reconnecting = false;

    // Build the MQTT topic for this device (friendly name or device id)
    if (this.options.name) {
      this.baseTopic = `${this.topic}/${this.options.name}/`;
    } else {
      this.baseTopic = `${this.topic}/${this.options.id}/`;
    }

    // Create the new Tuya Device
    this.device = new TuyAPI(JSON.parse(JSON.stringify(this.options)));

    // Listen for device data and call update DPS function if valid
    this.device.on("data", (data) => {
      if (typeof data === "object") {
        debug(
          "Received JSON data from device " + this.options.id + " ->",
          JSON.stringify(data.dps)
        );
        this.updateState(data);
      } else {
        if (data !== "json obj data unvalid") {
          debug(`Received string data from device ${this.options.id} ->`, data);
        }
      }
    });

    // Attempt to find/connect to device and start heartbeat monitor
    this.connectDevice();
    this.monitorHeartbeat();

    // On connect perform device specific init
    this.device.on("connected", async () => {
      // Sometimes TuyAPI reports connection even on socket error
      // Wait one second to check if device is really connected before initializing
      await utils.sleep(1);
      if (this.device.isConnected()) {
        debug("Connected to device " + this.toString());
        this.connected = true;
        this.heartbeatsMissed = 0;
        this.publishMqtt(this.baseTopic + "status", "online");
        this.publishMqtt(this.baseTopic + "reason", "device connected");
        try {
          this.init();
          debug("Initiated Device " + this.toString());
        } catch (e) {
          this.logError(`device init failed: ${this.toString()}`);
        }
      }
    });

    // On disconnect perform device specific disconnect
    this.device.on("disconnected", async () => {
      debug("Disconnected from device " + this.toString());
      this.connected = false;
      this.publishMqtt(this.baseTopic + "status", "offline");
      this.publishMqtt(this.baseTopic + "reason", "device disconnected");
      await utils.sleep(5);
      this.reconnect();
    });

    // On connect error call reconnect
    this.device.on("error", async (err) => {
      this.logError(err);
      await utils.sleep(1);
      this.reconnect();
    });

    // On heartbeat reset heartbeat timer
    this.device.on("heartbeat", () => {
      this.heartbeatsMissed = 0;
    });
  }
  logError(err: unknown) {
    debugError(err);
    this.publishMqtt(this.baseTopic + "log", `${err}`);
  }

  init() {
    throw new Error("Method not implemented.");
  }

  // Get and update cached values of all configured/known dps value for device
  async getStates() {
    const connectedPrev = this.connected;
    // Suppress topic updates while syncing device state with cached state
    this.connected = false;
    for (const topic in this.deviceTopics) {
      const key = this.deviceTopics[topic].key;
      if (!this.dps[key]) {
        this.dps[key] = {};
      }
      try {
        this.dps[key].val = await this.device.get({ dps: key });
        this.dps[key].updated = true;
      } catch {
        this.logError("Could not get value for device DPS key " + key);
      }
    }
    this.connected = connectedPrev;
    // Force topic update now that all states are fully syncronized
    this.publishTopics();
  }

  // Update cached DPS values on data updates
  updateState(data) {
    if (typeof data.dps !== "undefined") {
      // Update cached device state data
      for (const key in data.dps) {
        // Only update if the received value is different from previous value
        if (this.dps[key] !== data.dps[key]) {
          this.dps[key] = {
            val: data.dps[key],
            updated: true,
          };
        }
        if (this.isRgbtwLight) {
          if (this.config.dpsColor && this.config.dpsColor == key) {
            this.updateColorState(data.dps[key]);
          } else if (this.config.dpsMode && this.config.dpsMode == key) {
            // If color/white mode is changing, force sending color state
            // Allows overriding saturation value to 0% for white mode for the HSB device topics
            this.dps[this.config.dpsColor].updated = true;
          }
        }
      }
      if (this.connected) {
        this.publishTopics();
      }
    }
  }

  // Publish device specific state topics
  publishTopics() {
    // Don't publish if device is not connected
    if (!this.connected) return;

    // Loop through and publish all device specific topics
    for (const topic in this.deviceTopics) {
      const deviceTopic = this.deviceTopics[topic];
      const key = deviceTopic.key;
      // Only publish values if different from previous value
      if (this.dps[key]?.updated) {
        const state = this.getFriendlyState(deviceTopic, this.dps[key].val);

        this.publishMqtt(this.baseTopic + topic, state);
      }
    }

    // Publish Generic Dps Topics
    this.publishDpsTopics();
  }

  // Publish all dps-values to topic
  publishDpsTopics() {
    try {
      if (Object.keys(this.dps).length === 0) {
        return;
      }

      const dpsTopic = this.baseTopic + "dps";
      // Publish DPS JSON data if not empty
      const messageData = this.dps;
      for (const key in this.dps) {
        // Only publish values if different from previous value
        if (this.dps[key].updated) {
          messageData[key] = this.dps[key].val;
        }
      }
      const message = JSON.stringify(messageData);
      const dpsStateTopic = dpsTopic + "/state";
      debugState("MQTT DPS JSON: " + dpsStateTopic + " -> ", message);
      this.publishMqtt(dpsStateTopic, message);

      // Publish dps/<#>/state value for each device DPS
      for (const key in this.dps) {
        // Only publish values if different from previous value
        if (this.dps[key].updated) {
          const dpsKeyTopic = dpsTopic + "/" + key + "/state";
          const data = this.dps[key]?.val?.toString() || "None";
          debugState("MQTT DPS" + key + ": " + dpsKeyTopic + " -> ", data);
          this.publishMqtt(dpsKeyTopic, data);
          this.dps[key].updated = false;
        }
      }
    } catch (e) {
      this.logError(e);
    }
  }

  // Get the friendly topic state based on configured DPS value type
  getFriendlyState(deviceTopic: DeviceTopic, value: unknown) {
    let state;
    switch (deviceTopic.type) {
      case "bool":
        state = value ? "ON" : "OFF";
        break;
      case "int":
      case "float":
        state = this.parseNumberState(value, deviceTopic);
        break;
      case "hsb":
      case "hsbhex":
        // Return comma separate array of component values for specific topic
        state = [];
        const components = deviceTopic.components.split(",");
        for (const i in components) {
          // If light is in white mode always report saturation 0%, otherwise report actual value
          state.push(
            components[i] === "s" &&
              this.dps[this.config.dpsMode].val === "white"
              ? 0
              : this.color[components[i]]
          );
        }
        state = state.join(",");
        break;
      case "str":
        state = this.parseStringState(value);
        break;
    }
    return state;
  }

  parseStringState(value: unknown): string {
    return (value as string) || "";
  }

  // Parse the received state numeric value based on deviceTopic rules
  parseNumberState(value, deviceTopic) {
    // Check if it's a number and it's not outside of defined range
    if (isNaN(value)) {
      return "";
    }

    // Perform any required math transforms before returing command value
    switch (deviceTopic.type) {
      case "int":
        value = deviceTopic.stateMath
          ? parseInt(Math.round(evaluate(value + deviceTopic.stateMath)) as any)
          : parseInt(value);
        break;
      case "float":
        value = deviceTopic.stateMath
          ? parseFloat(evaluate(value + deviceTopic.stateMath))
          : parseFloat(value);
        break;
    }

    return value.toString();
  }

  // Initial processing of MQTT commands for all command topics
  processCommand(message, commandTopic) {
    let command;
    if (utils.isJsonString(message)) {
      debugCommand("Received MQTT command message is a JSON string");
      command = JSON.parse(message);
    } else {
      debugCommand("Received MQTT command message is a text string");
      command = message.toLowerCase();
    }

    // If get-states command, then updates all states and re-publish topics
    if (commandTopic === "command" && command === "get-states") {
      // Handle "get-states" command to update device state
      debugCommand("Received command: ", command);
      this.getStates();
    } else {
      // Call device specific command topic handler
      this.processDeviceCommand(command, commandTopic);
    }
  }

  // Process MQTT commands for all device command topics
  // eslint-disable-next-line @typescript-eslint/ban-types
  processDeviceCommand(command: string | {}, commandTopic: string) {
    // Determine state topic from command topic to find proper template
    const stateTopic = commandTopic.replace("command", "state");
    const deviceTopic = this.deviceTopics[stateTopic] || "";

    if (deviceTopic) {
      debugCommand(
        `Device ${
          this.options.id
        } received command topic: ${commandTopic}, message: ${JSON.stringify(
          command
        )}`
      );
      const commandResult = this.sendTuyaCommand(command, deviceTopic);
      if (!commandResult) {
        debugCommand(
          `Command topic ${this.baseTopic}${commandTopic} received invalid value: ${command}`
        );
      }
    } else {
      debugCommand(
        `Invalid command topic ${this.baseTopic}${commandTopic} for device id: ${this.config.id}. Expected '${deviceTopic}'.`
      );
    }
  }

  // Process Tuya JSON commands via DPS command topic
  processDpsCommand(message) {
    if (utils.isJsonString(message)) {
      const command = JSON.parse(message);
      debugCommand("Parsed Tuya JSON command: " + JSON.stringify(command));
      this.set(command);
    } else {
      debugCommand("DPS command topic requires Tuya style JSON value");
    }
  }

  // Process text based Tuya commands via DPS key command topics
  processDpsKeyCommand(message, dpsKey) {
    if (utils.isJsonString(message)) {
      debugCommand("Individual DPS command topics do not accept JSON values");
    } else {
      const dpsMessage = this.parseDpsMessage(message);
      debugCommand("Received command for DPS" + dpsKey + ": ", message);
      const command = {
        dps: dpsKey,
        set: dpsMessage,
      };
      this.set(command);
    }
  }

  // Parse string message into boolean and number types
  parseDpsMessage(message) {
    if (typeof message === "boolean") {
      return message;
    } else if (message === "true" || message === "false") {
      return message === "true";
    } else if (!isNaN(message)) {
      return Number(message);
    } else {
      return message;
    }
  }

  // Set state based on command topic
  sendTuyaCommand(message, deviceTopic) {
    let command = message.toLowerCase();
    const tuyaCommand: Record<string, any> = {};
    tuyaCommand.dps = deviceTopic.key;
    switch (deviceTopic.type) {
      case "bool":
        if (command === "toggle") {
          tuyaCommand.set = !this.dps[tuyaCommand.dps].val;
        } else {
          command = this.parseBoolCommand(command);
          // if (typeof command.set === 'boolean') {
          tuyaCommand.set = command.set;
          // } else {
          //     tuyaCommand.set = '!!!INVALID!!!'
          // }
        }
        break;
      case "int":
      case "float":
        tuyaCommand.set = this.parseNumberCommand(command, deviceTopic);
        break;
      case "hsb":
        this.updateCommandColor(command, deviceTopic.components);
        tuyaCommand.set = this.parseTuyaHsbColor();
        break;
      case "hsbhex":
        this.updateCommandColor(command, deviceTopic.components);
        tuyaCommand.set = this.parseTuyaHsbHexColor();
        break;
      default:
        // If type is not one of the above just use the raw string as is
        tuyaCommand.set = message;
    }
    if (tuyaCommand.set === "!!!INVALID!!!") {
      return false;
    } else {
      if (this.isRgbtwLight) {
        this.setLight(deviceTopic, tuyaCommand);
      } else {
        this.set(tuyaCommand);
      }
      return true;
    }
  }

  // Convert simple bool commands to true/false
  parseBoolCommand(command) {
    switch (command) {
      case "on":
      case "off":
      case "0":
      case "1":
      case "true":
      case "false":
        return {
          set: !!(
            command === "on" ||
            command === "1" ||
            command === "true" ||
            command === 1
          ),
        };
      default:
        return command;
    }
  }

  // Validate/transform set interger values
  parseNumberCommand(command, deviceTopic) {
    let value: any;
    const invalid = "!!!INVALID!!!";

    // Check if it's a number and it's not outside of defined range
    if (isNaN(command)) {
      return invalid;
    } else if (deviceTopic.topicMin && command < deviceTopic.topicMin) {
      this.logError(
        'Received command value "' +
          command +
          '" that is less than the configured minimum value'
      );
      this.logError(
        "Overriding command with minimum value " + deviceTopic.topicMin
      );
      command = deviceTopic.topicMin;
    } else if (deviceTopic.topicMax && command > deviceTopic.topicMax) {
      this.logError(
        'Received command value "' +
          command +
          '" that is greater than the configured maximum value'
      );
      this.logError(
        "Overriding command with maximum value: " + deviceTopic.topicMax
      );
      command = deviceTopic.topicMax;
    }

    // Perform any required math transforms before returing command value
    switch (deviceTopic.type) {
      case "int":
        if (deviceTopic.commandMath) {
          value = parseInt(
            Math.round(evaluate(command + deviceTopic.commandMath)) as any
          );
        } else {
          value = parseInt(command);
        }
        break;
      case "float":
        if (deviceTopic.commandMath) {
          value = parseFloat(evaluate(command + deviceTopic.commandMath));
        } else {
          value = parseFloat(command);
        }
        break;
    }

    return value;
  }

  // Takes Tuya color value in HSB or HSBHEX format and updates cached HSB color state for device
  // Credit homebridge-tuya project for HSB/HSBHEX conversion code
  updateColorState(value) {
    let h, s, b;
    if (this.config.colorType === "hsbhex") {
      [, h, s, b] = (value || "0000000000ffff").match(
        /^.{6}([0-9a-f]{4})([0-9a-f]{2})([0-9a-f]{2})$/i
      ) || [0, "0", "ff", "ff"];
      this.color.h = parseInt(h, 16);
      this.color.s = Math.round(parseInt(s, 16) / 2.55); // Convert saturation to 100 scale
      this.color.b = Math.round(parseInt(b, 16) / 2.55); // Convert brightness to 100 scale
    } else {
      [, h, s, b] = (value || "000003e803e8").match(
        /^([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})$/i
      ) || [0, "0", "3e8", "3e8"];
      // Convert from Hex to Decimal and cache values
      this.color.h = parseInt(h, 16);
      this.color.s = Math.round(parseInt(s, 16) / 10); // Convert saturation to 100 Scale
      this.color.b = Math.round(parseInt(b, 16) / 10); // Convert brightness to 100 scale
    }

    // Initialize the command color values with existing color state
    if (!this.cmdColor) {
      this.cmdColor = {
        h: this.color.h,
        s: this.color.s,
        b: this.color.b,
      };
    }
  }

  // Caches color updates when HSB components have separate device topics
  // cmdColor property always contains the desired HSB color state based on received
  // command topic messages vs actual device color state, which may be pending
  updateCommandColor(value, components) {
    // Update any HSB component with a changed value
    components = components.split(",");
    const values = value.split(",");
    for (const i in components) {
      this.cmdColor[components[i]] = Math.round(values[i]);
    }
  }

  // Returns Tuya HSB format value from current cmdColor HSB values
  // Credit homebridge-tuya project for HSB conversion code
  parseTuyaHsbColor() {
    const { h, s, b } = this.cmdColor;
    const hexColor =
      h.toString(16).padStart(4, "0") +
      (10 * s).toString(16).padStart(4, "0") +
      (10 * b).toString(16).padStart(4, "0");
    return hexColor;
  }

  // Returns Tuya HSBHEX format value from current cmdColor HSB values
  // Credit homebridge-tuya project for HSBHEX conversion code
  parseTuyaHsbHexColor() {
    let { h, s, b } = this.cmdColor;
    const hsb =
      h.toString(16).padStart(4, "0") +
      Math.round(2.55 * s)
        .toString(16)
        .padStart(2, "0") +
      Math.round(2.55 * b)
        .toString(16)
        .padStart(2, "0");
    h /= 60;
    s /= 100;
    b *= 2.55;
    const i = Math.floor(h);
    const f = h - i;
    const p = b * (1 - s);
    const q = b * (1 - s * f);
    const t = b * (1 - s * (1 - f));
    const rgb = (() => {
      switch (i % 6) {
        case 0:
          return [b, t, p];
        case 1:
          return [q, b, p];
        case 2:
          return [p, b, t];
        case 3:
          return [p, q, b];
        case 4:
          return [t, p, b];
        case 5:
          return [b, p, q];
        default:
          throw "no way!";
      }
    })().map((c) => Math.round(c).toString(16).padStart(2, "0"));
    const hex = rgb.join("");

    return hex + hsb;
  }

  // Set white/colour mode based on received commands
  async setLight(topic, command) {
    let targetMode: any;

    if (
      topic.key === this.config.dpsWhiteValue ||
      topic.key === this.config.dpsColorTemp
    ) {
      // If setting white level or color temperature, light should be in white mode
      targetMode = "white";
    } else if (topic.key === this.config.dpsColor) {
      // Split device topic HSB components into array
      const components = topic.components.split(",");

      // If device topic inlucdes saturation check for changes
      if (components.includes("s")) {
        if (this.cmdColor.s < 10) {
          // Saturation changed to < 10% = white mode
          targetMode = "white";
        } else {
          // Saturation changed to >= 10% = color mode
          targetMode = "colour";
        }
      } else {
        // For other cases stay in existing mode
        targetMode = this.dps[this.config.dpsMode].val;
      }
    }

    // Send the issued command
    this.set(command);

    // Make sure the bulb stays in the correct mode
    if (targetMode) {
      command = {
        dps: this.config.dpsMode,
        set: targetMode,
      };
      this.set(command);
    }
  }

  // Simple function to help debug output
  toString() {
    return `[${this.deviceData.mdl}] ${this.config.name} (${
      this.options.ip ? this.options.ip + ", " : ""
    }${this.options.id}, ${this.options.key})`;
  }

  async set(command) {
    debug("Set device " + this.options.id + " -> " + JSON.stringify(command));
    return await new Promise((resolve, reject) => {
      this.device.set(command).then((result) => {
        resolve(result);
      });
    });
  }

  // Search for and connect to device
  connectDevice() {
    // Find device on network
    debug("Search for device id " + this.options.id);
    this.device
      .find()
      .then(() => {
        debug("Found device id " + this.options.id);
        // Attempt connection to device
        this.device.connect().catch((error) => {
          this.logError(error.message);
          this.reconnect();
        });
      })
      .catch(async (error) => {
        this.logError(error.message);
        this.logError("Will attempt to find device again in 60 seconds");
        await utils.sleep(60);
        this.connectDevice();
      });
  }

  // Retry connection every 10 seconds if unable to connect
  async reconnect() {
    if (!this.reconnecting) {
      this.reconnecting = true;
      this.logError(
        `Error connecting to device id ${this.options.id}...retry in 10 seconds.`
      );
      await utils.sleep(10);
      this.connectDevice();
      this.reconnecting = false;
    }
  }

  // Republish device discovery/state data (used for Home Assistant state topic)
  async republish() {
    const status = this.device.isConnected() ? "online" : "offline";
    this.publishMqtt(this.baseTopic + "status", status);
    this.publishMqtt(this.baseTopic + "reason", `device isConnected=${status}`);
    await utils.sleep(1);
    this.init();
  }

  // Simple function to monitor heartbeats to determine if
  monitorHeartbeat() {
    setInterval(async () => {
      if (this.connected) {
        if (this.heartbeatsMissed > 3) {
          this.logError(
            `Device id ${this.options.id} not responding to heartbeats...disconnecting`
          );
          this.device.disconnect();
          await utils.sleep(1);
          this.connectDevice();
        } else if (this.heartbeatsMissed > 0) {
          const errMessage =
            this.heartbeatsMissed > 1 ? " heartbeats" : " heartbeat";
          this.logError(
            `Device id ${this.options.id} has missed ${this.heartbeatsMissed}${errMessage}`
          );
        }
        this.heartbeatsMissed++;
      }
    }, HEARTBEAT_MS);
  }

  // Publish MQTT
  publishMqtt(topic: string, message: string) {
    debugState(topic, message);
    this.mqttClient.publish(topic, message, { qos: 1 });
  }
}
