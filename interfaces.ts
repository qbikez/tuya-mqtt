export type DeviceConfig = {
  type: string;
};

export type DeviceInfo = {
  configDevice: DeviceConfig;
  topic: string;
  discoveryTopic: string;
};

export type DeviceTopic = {
  key: number;
  type: string;
  [key: string]: any;
};
