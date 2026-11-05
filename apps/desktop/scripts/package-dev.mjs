import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// A review artifact must never inherit the release build's production default.
const raw = process.env.MIKKA_DESKTOP_APP_URL
if (!raw) throw new Error('MIKKA_DESKTOP_APP_URL is required for a Mikka Dev test package')
const url = new URL(raw)
const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
if (url.username || url.password || !['http:', 'https:'].includes(url.protocol) || (!local && url.protocol !== 'https:')) {
  throw new Error('The test backend must be loopback HTTP(S) or credential-free HTTPS')
}
if (url.hostname === 'app.aspectlylabs.com' || url.hostname === 'mikka.vercel.app') {
  throw new Error('Mikka Dev acceptance packages cannot connect to production')
}
const cwd = fileURLToPath(new URL('..', import.meta.url))
const env = { ...process.env, MIKKA_DESKTOP_FLAVOR: 'dev', CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
for (const args of [['scripts/build.mjs'], ['node_modules/electron-builder/cli.js', '--config', 'electron-builder.dev.yml', '--mac', '--arm64', '--publish', 'never']]) {
  const result = spawnSync(process.execPath, args, { cwd, env, stdio: 'inherit' })
  if (result.error) throw new Error('Mikka Dev packaging could not start', { cause: result.error })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
