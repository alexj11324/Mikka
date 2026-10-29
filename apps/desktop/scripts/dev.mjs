// Watch the shell while the web app runs separately (`pnpm dev` in the repo
// root). Restarts Electron only when main or preload changes.

import { context } from 'esbuild'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const define = {
  __MIKKA_APP_URL__: JSON.stringify(process.env.MIKKA_DESKTOP_APP_URL ?? 'http://localhost:3000/mikka'),
  __MIKKA_APP_VERSION__: JSON.stringify(pkg.version),
  __MIKKA_FLAVOR__: JSON.stringify('dev'),
  __MIKKA_AUTH_ORIGINS__: JSON.stringify(['https://github.com', 'https://accounts.google.com']),
}

let child
function restart() {
  if (child) child.kill()
  child = spawn('electron', ['.'], { cwd: root, stdio: 'inherit', env: { ...process.env, MIKKA_DESKTOP_FLAVOR: 'dev' } })
  child.on('exit', code => { if (code && code !== 0) console.error(`electron exited with ${code}`) })
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

const main = await context({ ...options, entryPoints: [resolve(root, 'src/main/index.ts')], outfile: resolve(root, 'dist/main.cjs'), plugins: [{ name: 'restart', setup(build) { build.onEnd(result => { if (!result.errors.length) restart() }) } }] })
const preload = await context({ ...options, entryPoints: [resolve(root, 'src/preload/index.ts')], outfile: resolve(root, 'dist/preload.cjs') })
await Promise.all([main.watch(), preload.watch()])
