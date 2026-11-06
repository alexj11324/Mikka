// This alias is confined to the independent server graph. Existing React
// renderers keep the original package; only server cache needs an ALS owner.
export * from 'mikka-real-react'
export { default } from 'mikka-real-react'
export { requestCache as cache } from '../src/context'
