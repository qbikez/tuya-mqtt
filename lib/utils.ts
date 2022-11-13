class Utils {
  // Check if data is JSON or not
  isJsonString (data) {
    try {
      const parsedData = JSON.parse(data)
      if (parsedData && typeof parsedData === 'object') {
        return parsedData
      }
    } catch (e) {
      // ignore
     }

    return false
  }

  // Simple sleep function for various required delays
  async sleep (sec) {
    return await new Promise(res => setTimeout(res, sec * 1000))
  }

  async msSleep (ms) {
    return await new Promise(res => setTimeout(res, ms))
  }
}

const utils = new Utils()
export default utils
