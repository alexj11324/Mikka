// Lets node tests import server modules: Next resolves `server-only` to an
// empty module on the server; plain node has no such package.
import { registerHooks } from 'node:module'
import { createRequire } from 'node:module'

const empty = createRequire(import.meta.url).resolve('next/dist/compiled/server-only/empty.js')
registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'server-only' ? { url: `file://${empty}`, shortCircuit: true } : next(specifier, context)
  },
})
