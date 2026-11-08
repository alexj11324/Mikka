const { getDefaultConfig } = require('expo/metro-config')
const { withUniwindConfig } = require('uniwind/metro')
const { overlayResolver } = require('./ui-overlay')

const config = getDefaultConfig(__dirname)

// UI slots: today's components, or the hosted layer's when MIKKA_MOBILE_OVERLAY_DIR is set (docs/ui-overlay.md).
config.resolver.resolveRequest = overlayResolver(__dirname, process.env, config.resolver.resolveRequest)

// Uniwind styles HeroUI Native, beUI and our own classes from global.css; it must be the outermost wrapper.
module.exports = withUniwindConfig(config, {
  cssEntryFile: './global.css',
  dtsFile: './uniwind-types.d.ts',
})
