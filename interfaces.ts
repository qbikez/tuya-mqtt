export interface DeviceConfig {
  type: string
}

export interface DeviceInfo {
  configDevice: DeviceConfig
  mqttClient: any
  topic: string
  discoveryTopic: string
}
