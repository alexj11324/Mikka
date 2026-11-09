// Next aliases this marker in server bundles. Node integration tests run only
// on the server; resolve the marker without changing application behavior.
import { registerHooks } from 'node:module'
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'server-only') return { url: 'data:text/javascript,export {}', shortCircuit: true }
  return nextResolve(specifier, context)
} })
