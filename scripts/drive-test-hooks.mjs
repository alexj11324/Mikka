// Extensionless imports for source-only Drive tests.
//
// The application resolves `./contract` to `./contract.ts` through its bundler
// and tsconfig paths. node:test has no such resolution, so a source-only test
// of lib/drive cannot import the module under test without this. It resolves
// one thing only — a relative specifier with no extension that names a `.ts`
// file next to it — and leaves every other resolution to Node.
//
// It also answers `server-only`, the marker modules import to promise they
// never reach a client bundle. Node has no such package; the marker's own
// meaning (this code is server code) is already true of a test process.
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { url: 'data:text/javascript,export {}', shortCircuit: true }
    if (context.parentURL && (specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[a-z]+$/.test(specifier)) {
      const candidate = `${fileURLToPath(new URL(specifier, context.parentURL))}.ts`
      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})
