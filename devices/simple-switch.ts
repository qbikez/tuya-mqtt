import TuyaDevice from './tuya-device'
import utils from '../lib/utils'
import dbg from 'debug'

const debugDiscovery = dbg('tuya-mqtt:discovery')

export default class SimpleSwitch extends TuyaDevice {
  constructor (deviceInfo) {
    super(deviceInfo)
  }

  async init () {
    // Set device specific variables
    this.config.dpsPower = this.config.dpsPower ? this.config.dpsPower : 1

    this.deviceData.mdl = 'Switch/Socket'

    // Map generic DPS topics to device specific topic names
    this.deviceTopics = {
      state: {
        key: this.config.dpsPower,
        type: 'bool'
      }
    }

    // Send home assistant discovery data and give it a second before sending state updates
    this.initDiscovery()
    await utils.sleep(1)

    // Get initial states and start publishing topics
    const schema = await this.device.get({ schema: true })
    console.log('schema', schema)
    // this.publishMqtt(this.baseTopic + "schema", schema, true)

    this.getStates()
  }

  initDiscovery () {
    const configTopic = `${this.discoveryTopic}/switch/${this.options.name}_${this.options.id}/config`

    const discoveryData = {
      name: this.options.name ? this.options.name : this.config.id,
      state_topic: this.baseTopic + 'state',
      command_topic: this.baseTopic + 'command',
      availability_topic: this.baseTopic + 'status',
      payload_available: 'online',
      payload_not_available: 'offline',
      unique_id: this.config.id,
      device: this.deviceData
    }

    debugDiscovery('Home Assistant config topic: ' + configTopic)
    debugDiscovery(discoveryData)
    this.publishMqtt(configTopic, JSON.stringify(discoveryData))
  }
}
