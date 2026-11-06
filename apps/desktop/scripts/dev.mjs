// The backend runs separately. Both development and packaging load local UI;
// restart only after renderer, main and preload have all built successfully.

import { context } from 'esbuild'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { watch } from 'node:fs'
import { cp, mkdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRenderer } from './build-renderer.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const define = {
  __MIKKA_APP_URL__: JSON.stringify(process.env.MIKKA_DESKTOP_APP_URL ?? 'http://localhost:3000/mikka'),
  __MIKKA_APP_VERSION__: JSON.stringify(pkg.version),
  __MIKKA_FLAVOR__: JSON.stringify('dev'),
}

let child
const ready = { main: false, preload: false, renderer: false }
let restartTimer
let restarting = Promise.resolve()
let stopping = false
function restart() {
  clearTimeout(restartTimer)
  restartTimer = setTimeout(() => {
    restarting = restarting.then(async () => {
      if (stopping || !Object.values(ready).every(Boolean)) return
      if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited }
      if (stopping || !Object.values(ready).every(Boolean)) return
      child = spawn('electron', ['.'], { cwd: root, stdio: 'inherit', env: { ...process.env, MIKKA_DESKTOP_FLAVOR: 'dev' } })
      child.on('error', error => console.error('Electron could not start:', error.message))
      child.on('exit', code => { if (code && code !== 0) console.error(`electron exited with ${code}`) })
    }).catch(error => console.error('Electron restart failed:', error.message))
  }, 100)
}

const options = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  define,
  sourcemap: true,
  logLevel: 'info',
}

function built(name) {
  return { name: `ready-${name}`, setup(build) {
    build.onStart(() => { ready[name] = false })
    build.onEnd(result => { ready[name] = !result.errors.length; if (ready[name]) restart() })
  } }
}

await mkdir(resolve(root, 'dist'), { recursive: true })
await Promise.all(['offline.html', 'update.html'].map(name => cp(resolve(root, 'src', name), resolve(root, 'dist', name))))
await buildRenderer()
ready.renderer = true

const main = await context({ ...options, entryPoints: [resolve(root, 'src/main/index.ts')], outfile: resolve(root, 'dist/main.cjs'), plugins: [built('main')] })
const preload = await context({ ...options, entryPoints: [resolve(root, 'src/preload/index.ts')], outfile: resolve(root, 'dist/preload.cjs'), plugins: [built('preload')] })
await Promise.all([main.watch(), preload.watch()])

let rendererTimer
let rendererBuilding = false
let rendererAgain = false
async function rebuildRenderer() {
  if (rendererBuilding) { rendererAgain = true; return }
  rendererBuilding = true
  ready.renderer = false
  try {
    // Existing hashed assets stay available until the replacement app starts.
    await buildRenderer({ clean: false })
    ready.renderer = true
    restart()
  } catch (error) { console.error('Renderer build failed:', error.message) }
  finally {
    rendererBuilding = false
    if (rendererAgain && !stopping) { rendererAgain = false; void rebuildRenderer() }
  }
}
const repository = resolve(root, '../..')
const paths = ['app', 'components', 'hooks', 'lib', 'messages', 'i18n', 'public', 'packages/protocol/src', 'apps/desktop/src/renderer']
const watchers = paths.map(path => watch(resolve(repository, path), { recursive: true }, (_event, filename) => {
  if (!filename || /(?:\.test\.[cm]?[jt]sx?|\.db\.test\.[cm]?[jt]s)$/.test(String(filename))) return
  clearTimeout(rendererTimer)
  rendererTimer = setTimeout(() => { void rebuildRenderer() }, 150)
}))
async function stop() {
  stopping = true
  clearTimeout(restartTimer); clearTimeout(rendererTimer)
  for (const watcher of watchers) watcher.close()
  child?.kill()
  await Promise.all([main.dispose(), preload.dispose()])
}
process.once('SIGINT', () => { void stop() })
process.once('SIGTERM', () => { void stop() })
