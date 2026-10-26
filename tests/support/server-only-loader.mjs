import { registerHooks } from 'node:module'

// Node-only integration tests exercise server modules outside Next's bundler.
// This import boundary does not replace authentication, authorization or database logic.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { url: 'data:text/javascript,export{}', shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
