// global.css is read by Uniwind through Metro (metro.config.js).
declare module '*.css'

// An .svg file is its markup, drawn with SvgXml (metro-svg-transformer.js).
declare module '*.svg' {
  const markup: string
  export default markup
}
