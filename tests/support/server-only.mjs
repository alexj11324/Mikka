// Test-only: lets node:test import modules marked `import 'server-only'`.
// Next resolves that package itself; plain node has no copy of it, so map it to an empty module.
import { register } from 'node:module'

register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === 'server-only') return { url: 'data:text/javascript,export {}', shortCircuit: true }
  return next(specifier, context)
}`))
