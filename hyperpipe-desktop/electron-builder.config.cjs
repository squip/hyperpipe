const packageJson = require('./package.json')

const baseConfig = packageJson.build || {}
const macConfig = baseConfig.mac || {}
const enableInlineNotarize =
  process.env.HYPERPIPE_ELECTRON_BUILDER_NOTARIZE === '1' &&
  process.env.APPLE_TEAM_ID

module.exports = {
  ...baseConfig,
  mac: {
    ...macConfig,
    ...(enableInlineNotarize
      ? {
          notarize: { teamId: process.env.APPLE_TEAM_ID }
        }
      : {})
  }
}
