// Ship the existing application's React renderer beside main and preload.
// __MIKKA_APP_URL__ identifies the backend; normal launch never downloads UI.

import { build } from 'esbuild'
import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRenderer } from './build-renderer.mjs'
import { desktopOverlayEvidence } from '../../../scripts/release/hosted-ui.mjs'

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
await buildRenderer({ outdir: resolve(outdir, 'renderer'), publicTestFixture: process.argv.includes('--public-test-fixture') })

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
await cp(resolve(root, 'src/update.html'), resolve(outdir, 'update.html'))

if (process.env.MIKKA_UI_OVERLAY_DIR) await desktopOverlayEvidence(outdir, process.env.MIKKA_UI_OVERLAY_SHA)

console.log(`built @mikka/desktop ${pkg.version} (${flavor}) -> ${appUrl}`)
