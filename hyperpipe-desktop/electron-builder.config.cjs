const packageJson = require('./package.json')

const baseConfig = packageJson.build || {}
const macConfig = baseConfig.mac || {}

module.exports = {
  ...baseConfig,
  mac: {
    ...macConfig,
    notarize: process.env.APPLE_TEAM_ID
      ? { teamId: process.env.APPLE_TEAM_ID }
      : {}
  }
}
