#!/usr/bin/env node
import fs from "fs";
import mqtt from "mqtt";
import dbg from "debug";
import SimpleCover from "./devices/simple-cover";
import SimpleSwitch from "./devices/simple-switch";
//import SimpleDimmer from "./devices/simple-dimmer";
//import RGBTWLight from "./devices/rgbtw-light";
import GenericDevice from "./devices/generic-device";
import utils from "./lib/utils";
import CONFIG from "./config.json";
import { DeviceConfig, DeviceInfo } from "./interfaces";
import { connectMqtt } from "./lib/mqtt";
import TuyaDevice from "./devices/tuya-device";

const REPUBLISH_PERIOD = 60000;

const debug = dbg("tuya-mqtt:info");
const debugCommand = dbg("tuya-mqtt:command");
const debugError = dbg("tuya-mqtt:error");

const tuyaDevices: TuyaDevice[] = [];

// Setup Exit Handlers
process.on("exit", processExit.bind(0));
process.on("SIGINT", processExit.bind(0));
process.on("SIGTERM", processExit.bind(0));
process.on("uncaughtException", processExit.bind(1));

// Disconnect from and publish offline status for all devices on exit
async function processExit(exitCode) {
  for (const tuyaDevice of tuyaDevices) {
    tuyaDevice.device.disconnect();
  }
  if (exitCode || exitCode === 0) debug("Exit code: " + exitCode);
  await utils.sleep(1);
  process.exit();
}

// Get new deivce based on configured type
function createDevice(deviceConfig: DeviceConfig) {
  const deviceInfo: DeviceInfo = {
    config: deviceConfig,
    topic: CONFIG.topic,
    discoveryTopic: CONFIG.discovery_topic,
  };

  switch (deviceConfig.type) {
    case "SimpleCover":
      return new SimpleCover(deviceInfo);
    case "SimpleSwitch":
      return new SimpleSwitch(deviceInfo);
    // case "SimpleDimmer":
    //   return new SimpleDimmer(deviceInfo);
    // case "RGBTWLight":
    //   return new RGBTWLight(deviceInfo);
    default:
      return new GenericDevice(deviceInfo);
  }
}

function initDevices(configDevices: DeviceConfig[]) {
  for (const configDevice of configDevices) {
    const newDevice = createDevice(configDevice);
    tuyaDevices.push(newDevice);
  }
}

// Republish devices 2x with 30 seconds sleep if restart of HA is detected
async function republishDevices() {
  for (let i = 0; i < 2; i++) {
    debug("Resending device config/state in 30 seconds");
    await utils.sleep(30);
    for (const device of tuyaDevices) {
      device.republish();
    }
    await utils.sleep(2);
  }
}

const initMQtt = () => {
  const mqttClient = connectMqtt(CONFIG);

  mqttClient.on("connect", function (err) {
    debug("Connection established to MQTT server");
    const topic = `${CONFIG.topic}/#`;
    mqttClient.subscribe(topic);
    const statusTopic = CONFIG.status_topic || "homeassistant/status";
    mqttClient.subscribe(statusTopic);
  });

  mqttClient.on("reconnect", function (error) {
    if (mqttClient.connected) {
      debug("Connection to MQTT server lost. Attempting to reconnect...");
    } else {
      debug("Unable to connect to MQTT server");
    }
  });

  mqttClient.on("error", function (error) {
    debug("Unable to connect to MQTT server", error);
  });

  mqttClient.on("message", function (topic: string, message: string) {
    try {
      message = message.toString();
      const splitTopic = topic.split("/");
      const topicLength = splitTopic.length;
      const commandTopic = splitTopic[topicLength - 1];
      const deviceTopicLevel = splitTopic[1];

      if (topic === "homeassistant/status" || topic === "hass/status") {
        debug(
          "Home Assistant state topic " +
            topic +
            " received message: " +
            message
        );
        if (message === "online") {
          republishDevices();
        }
      } else if (commandTopic.includes("command") || commandTopic.startsWith("set")) {
        // If it looks like a valid command topic try to process it
        debugCommand(
          "Received MQTT message -> ",
          JSON.stringify({
            topic,
            message,
          })
        );

        // Use device topic level to find matching device
        const device = tuyaDevices.find(
          (d) =>
            d.options.name === deviceTopicLevel ||
            d.options.id === deviceTopicLevel
        );

        if (!device) {
          debugError(`Device for topic '${deviceTopicLevel}' not found!`);
          return;
        }

        switch (topicLength) {
          case 3:
            device.processCommand(message, commandTopic);
            break;
          case 4:
            device.processDpsCommand(message);
            break;
          case 5:
            const dpsKey = splitTopic[topicLength - 2];
            device.processDpsKeyCommand(message, dpsKey);
            break;
          default:
            debugError(`Invalid command topic: ${topic}`);
        }
      }
    } catch (e) {
      debugError(e);
    }
  });
};

// Main code function
const main = async () => {
  let configDevices: DeviceConfig[] = [];
  try {
    const content = fs.readFileSync("./devices.json", "utf8");
    configDevices = JSON.parse(content);
  } catch (e) {
    console.error("Devices file not found!");
    debugError(e);
    process.exit(1);
  }

  initDevices(configDevices);

  initMQtt();

  if (configDevices.length === 0) {
    console.error("No devices found in devices file!");
    process.exit(1);
  }
};

setTimeout(() => republishDevices(), REPUBLISH_PERIOD);
// Call the main code
main();
