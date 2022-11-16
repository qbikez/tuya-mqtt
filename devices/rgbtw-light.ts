import TuyaDevice from "./tuya-device";
import dbg from "debug";
import utils from "../lib/utils";

const debug = dbg("tuya-mqtt:device-detect");
const debugDiscovery = dbg("tuya-mqtt:discovery");

export default class RGBTWLight extends TuyaDevice {
  guess: any;

  async init() {
    // If no manual config try to detect device settings
    if (!this.config.dpsPower) {
      await this.guessLightInfo();
    }

    // If detection failed and no manual config return without initializing
    if (!this.guess.dpsPower && !this.config.dpsPower) {
      debug(
        "Automatic discovery of Tuya bulb settings failed and no manual configuration"
      );
      return;
    }

    // Set device specific variables
    this.config.dpsPower = this.config.dpsPower
      ? this.config.dpsPower
      : this.guess.dpsPower;
    this.config.dpsMode = this.config.dpsMode
      ? this.config.dpsMode
      : this.guess.dpsMode;
    this.config.dpsWhiteValue = this.config.dpsWhiteValue
      ? this.config.dpsWhiteValue
      : this.guess.dpsWhiteValue;
    this.config.whiteValueScale = this.config.whiteValueScale
      ? this.config.whiteValueScale
      : this.guess.whiteValueScale;
    this.config.dpsColorTemp = this.config.dpsColorTemp
      ? this.config.dpsColorTemp
      : this.guess.dpsColorTemp;
    this.config.minColorTemp = this.config.minColorTemp
      ? this.config.minColorTemp
      : 154; // ~6500K
    this.config.maxColorTemp = this.config.maxColorTemp
      ? this.config.maxColorTemp
      : 400; // ~2500K
    this.config.colorTempScale = this.config.colorTempScale
      ? this.config.colorTempScale
      : this.guess.colorTempScale;
    this.config.dpsColor = this.config.dpsColor
      ? this.config.dpsColor
      : this.guess.dpsColor;
    this.config.colorType = this.config.colorType
      ? this.config.colorType
      : this.guess.colorType;

    this.deviceData.mdl = "RGBTW Light";
    this.isRgbtwLight = true;

    // Set white value transform math
    let whiteValueStateMath;
    let whiteValueCommandMath;
    if (this.config.whiteValueScale === 255) {
      // Devices with brightness scale of 255 seem to not allow values
      // less then 25 (10%) without producing timeout errors.
      whiteValueStateMath = "/2.3-10.86";
      whiteValueCommandMath = "*2.3+25";
    } else {
      // For other scale (usually 1000), 10-1000 seems OK.
      whiteValueStateMath = "/(" + this.config.whiteValueScale + "/100)";
      whiteValueCommandMath = "*(" + this.config.whiteValueScale + "/100)";
    }

    // Map generic DPS topics to device specific topic names
    this.deviceTopics = {
      state: {
        key: this.config.dpsPower,
        type: "bool",
      },
      white_brightness_state: {
        key: this.config.dpsWhiteValue,
        type: "int",
        topicMin: 0,
        topicMax: 100,
        stateMath: whiteValueStateMath,
        commandMath: whiteValueCommandMath,
      },
      hs_state: {
        key: this.config.dpsColor,
        type: this.config.colorType,
        components: "h,s",
      },
      color_brightness_state: {
        key: this.config.dpsColor,
        type: this.config.colorType,
        components: "b",
      },
      hsb_state: {
        key: this.config.dpsColor,
        type: this.config.colorType,
        components: "h,s,b",
      },
      mode_state: {
        key: this.config.dpsMode,
        type: "str",
      },
    };

    // If device supports Color Temperature add color temp device topic
    if (this.config.dpsColorTemp) {
      // Values used for tranforming from 1-255 scale to mireds range
      const rangeFactor =
        (this.config.maxColorTemp - this.config.minColorTemp) / 100;
      const scaleFactor = this.config.colorTempScale / 100;
      const tuyaMaxColorTemp =
        (this.config.maxColorTemp / rangeFactor) * scaleFactor;

      this.deviceTopics.color_temp_state = {
        key: this.config.dpsColorTemp,
        type: "int",
        topicMin: this.config.minColorTemp,
        topicMax: this.config.maxColorTemp,
        stateMath:
          "/" +
          scaleFactor +
          "*-" +
          rangeFactor +
          "+" +
          this.config.maxColorTemp,
        commandMath:
          "/" + rangeFactor + "*-" + scaleFactor + "+" + tuyaMaxColorTemp,
      };
    }

    // Send home assistant discovery data and give it a second before sending state updates
    this.initDiscovery();
    await utils.sleep(1);

    // Get initial states and start publishing topics
    this.getStates();
  }

  initDiscovery() {
    const configTopic = `${this.discoveryTopic}/switch/${this.config.id}/config`;

    const discoveryData: Record<string, string | number | any> = {
      name: this.config.name ? this.config.name : this.config.id,
      state_topic: this.baseTopic + "state",
      command_topic: this.baseTopic + "command",
      brightness_state_topic: this.baseTopic + "color_brightness_state",
      brightness_command_topic: this.baseTopic + "color_brightness_command",
      brightness_scale: 100,
      hs_state_topic: this.baseTopic + "hs_state",
      hs_command_topic: this.baseTopic + "hs_command",
      white_value_state_topic: this.baseTopic + "white_brightness_state",
      white_value_command_topic: this.baseTopic + "white_brightness_command",
      white_value_scale: 100,
      availability_topic: this.baseTopic + "status",
      payload_available: "online",
      payload_not_available: "offline",
      unique_id: this.config.id,
      device: this.deviceData,
    };

    if (this.config.dpsColorTemp) {
      discoveryData.color_temp_state_topic =
        this.baseTopic + "color_temp_state";
      discoveryData.color_temp_command_topic =
        this.baseTopic + "color_temp_command";
      discoveryData.min_mireds = this.config.minColorTemp;
      discoveryData.max_mireds = this.config.maxColorTemp;
    }

    debugDiscovery("Home Assistant config topic: " + configTopic);
    debugDiscovery(discoveryData);
    this.publishMqtt(configTopic, JSON.stringify(discoveryData));
  }

  async guessLightInfo() {
    this.guess = new Object();
    debug("Attempting to detect light capabilites and DPS values...");
    debug("Querying DPS 2 for white/color mode setting...");

    // Check if DPS 2 contains typical values for RGBTW light
    const mode2 = await this.device.get({ dps: 2 });
    const mode21 = await this.device.get({ dps: 21 });
    if (
      mode2 &&
      (mode2 === "white" ||
        mode2 === "colour" ||
        mode2.toString().includes("scene"))
    ) {
      debug(
        "Detected likely Tuya color bulb at DPS 1-5, checking more details..."
      );
      this.guess = {
        dpsPower: 1,
        dpsMode: 2,
        dpsWhiteValue: 3,
        whiteValueScale: 255,
        dpsColorTemp: 4,
        colorTempScale: 255,
        dpsColor: 5,
      };
    } else if (
      mode21 &&
      (mode21 === "white" ||
        mode21 === "colour" ||
        mode21.toString().includes("scene"))
    ) {
      debug(
        "Detected likely Tuya color bulb at DPS 20-24, checking more details..."
      );
      this.guess = {
        dpsPower: 20,
        dpsMode: 21,
        dpsWhiteValue: 22,
        whiteValueScale: 1000,
        dpsColorTemp: 23,
        colorTempScale: 1000,
        dpsColor: 24,
      };
    }

    if (this.guess.dpsPower) {
      debug("Attempting to detect if bulb supports color temperature...");
      const colorTemp = await this.device.get({ dps: this.guess.dpsColorTemp });
      if (
        colorTemp !== "" &&
        colorTemp >= 0 &&
        colorTemp <= this.guess.colorTempScale
      ) {
        debug("Detected likely color temperature support");
      } else {
        debug("No color temperature support detected");
        this.guess.dpsColorTemp = 0;
      }
      debug("Attempting to detect Tuya color format used by device...");
      const color = await this.device.get({ dps: this.guess.dpsColor });
      if (this.guess.dpsPower === 1) {
        this.guess.colorType = color && color.length === 12 ? "hsb" : "hsbhex";
      } else {
        this.guess.colorType = color && color.length === 14 ? "hsbhex" : "hsb";
      }
      debug("Detected Tuya color format " + this.guess.colorType.toUpperCase());
    }
  }

  override updateState(data: { dps: { [key: string]: {} } | undefined }): void {
    super.updateState(data);

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
}
