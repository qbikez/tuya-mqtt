export type DeviceConfig = {
  type: string;
};

export type DeviceInfo = {
  configDevice: DeviceConfig;
  mqttClient: any;
  topic: string;
  discoveryTopic: string;
};
