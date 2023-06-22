export type DeviceConfig = {
  type: string;
  id: string;
  key: string;
  name?: string;
  template?: Record<string, DeviceTopic>;
  version?: string;
  ip?: string;
  dpsMode?: string;
  dpsPower?: number;
};

export type DeviceInfo = {
  config: DeviceConfig;
  topic: string;
  discoveryTopic: string;
};

export type DeviceTopic = {
  key: number;
  type: string;
  [key: string]: any;
};

// eslint-disable-next-line @typescript-eslint/ban-types
export type MqttMessage = string | Record<string, {}>;

export type DPS = {
  [key: string]: {
    val: unknown;
    updated?: boolean;
  };
};
