import TuyaDevice from "./tuya-device";
import dbg from "debug";
import utils from "../lib/utils";

const debug = dbg("tuya-mqtt:device");
const debugDiscovery = dbg("tuya-mqtt:discovery");

export default class SimpleCover extends TuyaDevice {
  async init() {
    // Set device specific variables
    this.config.dpsPower = this.config.dpsPower || 1;

    this.deviceData.mdl = "Cover";

    // Map generic DPS topics to device specific topic names
    this.deviceTopics = {
      state: {
        key: this.config.dpsPower,
        type: "str",
      },
    };

    // Send home assistant discovery data and give it a second before sending state updates
    this.initDiscovery();
    await utils.sleep(1);

    // Get initial states and start publishing topics
    const schema = await this.device.get({ schema: true });
    console.log("schema", schema);
    // this.publishMqtt(this.baseTopic + "schema", schema, true)

    this.getStates();
  }

  initDiscovery() {
    const configTopic = `${this.discoveryTopic}/cover/${this.options.name}/config`;

    const discoveryData = {
      name: this.options.name ? this.options.name : this.config.id,
      state_topic: `${this.baseTopic}state`,
      command_topic: `${this.baseTopic}command`,
      availability_topic: `${this.baseTopic}status`,
      payload_available: "online",
      payload_not_available: "offline",
      unique_id: this.options.name,
      device: this.deviceData,
      position_topic: `${this.baseTopic}position`,
      set_position_topic: `${this.baseTopic}set_position`,
      optimistic: true,
    };

    debugDiscovery("Home Assistant config topic: " + configTopic);
    debugDiscovery(discoveryData);
    this.publishMqtt(configTopic, JSON.stringify(discoveryData), { qos: 1, retain: true });
  }

  override publishTopics(): void {
    super.publishTopics();
    const deviceTopic = this.deviceTopics["state"];
    const key = deviceTopic.key;
    const state = this.getFriendlyState(deviceTopic, this.dps[key].val);
    const position = state == "opening" ? 0 : state == "closing" ? 100 : 50;
    this.publishMqtt(this.baseTopic + "position", `${position}`);
  }

  override parseStringState(value: unknown): string {
    const map = {
      open: "opening",
      close: "closing",
      stop: "stopped",
    };

    return map[value as string];
  }
}
