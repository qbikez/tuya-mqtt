import * as mqtt from "mqtt";
import { debug, debugError } from "./logging";

export let mqttClient: mqtt.MqttClient;

export function connectMqtt(config: {
  host: string;
  port: number;
  mqtt_user: string;
  mqtt_pass: string;
}) {
  if (mqttClient) {
    throw new Error("MQTT client already connected");
  }
  mqttClient = mqtt.connect({
    host: config.host,
    port: config.port,
    username: config.mqtt_user,
    password: config.mqtt_pass,
  });
  return mqttClient;
}
