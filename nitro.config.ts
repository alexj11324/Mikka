// Nitro's CLI and Node builder both resolve configuration at the repository
// root. Keep this wrapper explicit so production and development use one graph.
export { default } from './apps/api/nitro.config'
