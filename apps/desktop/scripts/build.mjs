// Build the main and preload bundles. The renderer is the web app served at
// `__MIKKA_APP_URL__`; nothing from this app is shipped to it.

import { build } from 'esbuild'
import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outdir = resolve(root, 'dist')
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const flavor = process.env.MIKKA_DESKTOP_FLAVOR === 'dev' ? 'dev' : 'prod'
const appUrl = process.env.MIKKA_DESKTOP_APP_URL
  ?? (flavor === 'dev' ? 'http://localhost:3000/mikka' : 'https://app.aspectlylabs.com/mikka')

const parsed = new URL(appUrl)
if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) {
  throw new Error('MIKKA_DESKTOP_APP_URL must be an HTTP(S) URL without credentials')
}
if (flavor === 'prod' && parsed.protocol !== 'https:') {
  throw new Error('A production desktop build must load the app over HTTPS')
}

const define = {
  __MIKKA_APP_URL__: JSON.stringify(appUrl),
  __MIKKA_APP_VERSION__: JSON.stringify(pkg.version),
  __MIKKA_FLAVOR__: JSON.stringify(flavor),
}

await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  define,
  logLevel: 'info',
}

await build({ ...common, entryPoints: [resolve(root, 'src/main/index.ts')], outfile: resolve(outdir, 'main.cjs'), sourcemap: flavor === 'dev' })
await build({ ...common, entryPoints: [resolve(root, 'src/preload/index.ts')], outfile: resolve(outdir, 'preload.cjs'), sourcemap: flavor === 'dev' })
await cp(resolve(root, 'src/offline.html'), resolve(outdir, 'offline.html'))

console.log(`built @mikka/desktop ${pkg.version} (${flavor}) -> ${appUrl}`)
