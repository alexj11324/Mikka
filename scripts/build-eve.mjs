import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function buildEve({ root = process.cwd(), env = process.env, execute = execFileSync } = {}) {
  const revision = env.MIKKA_BUILD_REVISION || execute('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('EVE_BUILD_REVISION_REQUIRED')
  const preset = env.NITRO_PRESET || 'node-server'
  if (preset !== 'node-server') throw new Error('EVE_BUILD_PRESET_INVALID')
  const postgres = env.WORKFLOW_TARGET_WORLD === '@workflow/world-postgres'
  const eve = JSON.parse(await readFile(join(root, 'node_modules/eve/package.json'), 'utf8')).version
  if (eve !== '1.0.0-rc.9') throw new Error('EVE_BUILD_VERSION_MISMATCH')
  const childEnv = { ...env, NITRO_PRESET: preset, EVE_PUBLIC_ROUTE_PREFIX: '/mikka/api/agents' }
  delete childEnv.VERCEL
  execute(process.execPath, [join(root, 'node_modules/eve/bin/eve.js'), 'build'], {
    cwd: join(root, 'apps/eve'), stdio: 'inherit', env: childEnv,
  })
  const output = join(root, 'apps/eve/.output')
  await writeFile(join(output, 'mikka-eve-build.json'), `${JSON.stringify({ version: 1, eve, revision, preset, ...(postgres ? { world: '@workflow/world-postgres', worldVersion: '5.2.0' } : {}) })}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildEve()
