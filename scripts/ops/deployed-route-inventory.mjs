import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { routeProbePlan } from './route-probe.mjs'

const execute = promisify(execFile)

/** Read data from the serving API's immutable main commit, never its code. */
export async function deployedRouteInventory(baseUrl, repository = process.cwd()) {
  const origin = new URL(baseUrl)
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) throw new Error('route_inventory_origin_invalid')
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('route_inventory_origin_invalid')
  const response = await fetch(new URL('/mikka/api/version', origin), {
    credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error('route_inventory_version_unavailable')
  const version = await response.json()
  if (!/^[a-f0-9]{40}$/.test(version.build ?? '')) throw new Error('route_inventory_source_invalid')
  const source = version.build
  await execute('git', ['merge-base', '--is-ancestor', source, 'origin/main'], { cwd: repository })
  const { stdout } = await execute('git', ['show', `${source}:apps/api/generated/routes.json`], { cwd: repository, maxBuffer: 4 * 1024 * 1024 })
  const manifest = JSON.parse(stdout)
  routeProbePlan(manifest)
  return { source, manifest }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { source, manifest } = await deployedRouteInventory(process.env.ROUTE_PROBE_BASE_URL)
    const output = resolve(process.env.ROUTE_PROBE_MANIFEST ?? '.cache/deployed-routes.json')
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, JSON.stringify(manifest) + '\n')
    console.log(`Route inventory: source=${source} routes=${manifest.routes.length}`)
  } catch (error) {
    // Git and HTTP errors may contain operator addresses. Keep only the closed code.
    const code = /^route_inventory_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'route_inventory_source_unavailable'
    console.error(code)
    process.exitCode = 1
  }
}
