import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

// Emit self-contained Node ESM. Next's TypeScript import resolution stays
// unchanged; the isolated broker never executes extensionless TS imports.
const path = name => fileURLToPath(new URL(name, import.meta.url))
await build({
  entryPoints: [path('src/fill.ts'), path('src/oidc.ts')],
  outdir: path('dist'), bundle: true, platform: 'node', target: 'node24', format: 'esm',
  external: ['pg-native'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
})
