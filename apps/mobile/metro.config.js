const { getDefaultConfig } = require('expo/metro-config')
const { withUniwindConfig } = require('uniwind/metro')
const { overlayResolver } = require('./ui-overlay')

const config = getDefaultConfig(__dirname)

// UI slots: today's components, or the hosted layer's when MIKKA_MOBILE_OVERLAY_DIR is set (docs/ui-overlay.md).
config.resolver.resolveRequest = overlayResolver(__dirname, process.env, config.resolver.resolveRequest)

// .svg files are markup strings for SvgXml (metro-svg-transformer.js), not image assets.
config.transformer.babelTransformerPath = require.resolve('./metro-svg-transformer')
config.resolver.assetExts = config.resolver.assetExts.filter(ext => ext !== 'svg')
config.resolver.sourceExts = [...config.resolver.sourceExts, 'svg']

// Uniwind styles HeroUI Native, beUI and our own classes from global.css; it must be the outermost wrapper.
module.exports = withUniwindConfig(config, {
  cssEntryFile: './global.css',
  dtsFile: './uniwind-types.d.ts',
})
