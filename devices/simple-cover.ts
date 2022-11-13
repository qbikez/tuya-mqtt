import TuyaDevice from './tuya-device'
import dbg from 'debug'
import utils from '../lib/utils'

const debug = dbg('tuya-mqtt:device')
const debugDiscovery = dbg('tuya-mqtt:discovery')

export default class SimpleCover extends TuyaDevice {
  async init () {
    // Set device specific variables
    this.config.dpsPower = this.config.dpsPower ? this.config.dpsPower : 1

    this.deviceData.mdl = 'Cover'

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
    const configTopic = `${this.discoveryTopic}/cover/${this.options.name}/config`

    const discoveryData = {
      name: this.options.name ? this.options.name : this.config.id,
      state_topic: `${this.baseTopic}state`,
      command_topic: `${this.baseTopic}command`,
      availability_topic: `${this.baseTopic}status`,
      payload_available: 'online',
      payload_not_available: 'offline',
      unique_id: this.options.name,
      device: this.deviceData
    }

    debugDiscovery('Home Assistant config topic: ' + configTopic)
    debugDiscovery(discoveryData)
    this.publishMqtt(configTopic, JSON.stringify(discoveryData))
  }

  parseBoolCommand (command) {
    debug(`parse bool command: ${command}`)
    return {
      set: command
    }
  }
}
