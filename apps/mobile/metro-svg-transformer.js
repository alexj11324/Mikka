// An .svg file reads as its markup (a string), drawn with react-native-svg's SvgXml: the Agents' brand marks come
// from @lobehub/icons-static-svg (MIT) as files, so the app never copies their paths. Everything else goes to Expo's
// own Babel transformer unchanged.
const upstream = require(require.resolve('@expo/metro-config/build/babel-transformer', { paths: [require.resolve('expo/package.json')] }))

module.exports = {
  ...upstream,
  transform(props) {
    if (!props.filename.endsWith('.svg')) return upstream.transform(props)
    return upstream.transform({ ...props, src: `module.exports = ${JSON.stringify(props.src)};` })
  },
}
