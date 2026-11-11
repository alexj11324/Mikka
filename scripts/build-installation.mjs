import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { recordOverlay } from './release/hosted-ui.mjs'

/** The default distributable from a public checkout is the server and its own
 * authentication/status pages. A declared official release must have both pins. */
export async function installationBuild(env) {
  const directory = env.MIKKA_UI_OVERLAY_DIR?.trim()
  const revision = env.MIKKA_UI_OVERLAY_SHA?.trim()
  const productionWeb = env.VERCEL === '1' && env.VERCEL_ENV === 'production'
  if (!directory && !revision && !productionWeb) return 'build:server'
  if (!directory || !/^[0-9a-f]{40}$/.test(revision ?? '')) throw new Error('OFFICIAL_UI_CHECKOUT_AND_REVISION_REQUIRED')
  await recordOverlay(directory, { env: { MIKKA_UI_OVERLAY_SHA: revision } })
  return 'build:app'
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const task = await installationBuild(process.env)
  const manager = process.env.npm_execpath
  const result = manager
    ? spawnSync(process.execPath, [manager, 'run', task], { stdio: 'inherit' })
    : spawnSync('pnpm', ['run', task], { stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
}
