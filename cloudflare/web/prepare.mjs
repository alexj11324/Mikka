import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isValidDeploymentId } from '../../lib/deployment-id.mjs'
import { assertNoSourceMaps } from '../../scripts/release/hosted-ui.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const serviceName = /^[a-z][a-z0-9-]{0,62}$/
const nameForRelease = id => `mikka-app-release-${id}`
const common = { compatibility_date: '2026-10-19', workers_dev: false, preview_urls: false }

export async function releaseConfig({ id, assets, api, cloud }) {
  if (!isValidDeploymentId(id) || id !== id.toLowerCase() || !serviceName.test(nameForRelease(id))) throw new Error('WEB_RELEASE_ID_INVALID')
  if (![api, cloud].every(name => typeof name === 'string' && serviceName.test(name)) || api === cloud) {
    throw new Error('WEB_RELEASE_SERVICE_INVALID')
  }
  const directory = resolve(assets)
  await assertNoSourceMaps(directory)
  const inventory = JSON.parse(await readFile(resolve(directory, 'renderer-manifest.json'), 'utf8'))
  if (inventory.target !== 'web' || !inventory.inputs?.some(path => path.startsWith('.hosted-ui/slots/'))
      || !Array.isArray(inventory.serverModules) || inventory.serverModules.length) {
    throw new Error('WEB_RELEASE_OFFICIAL_UI_REQUIRED')
  }
  const html = await readFile(resolve(directory, 'index.html'), 'utf8')
  const assetsInShell = [...html.matchAll(/\b(?:src|href)=["'](\/mikka\/[^"']*)["']/g)].map(match => new URL(match[1].replaceAll('&amp;', '&'), 'https://mikka.invalid'))
  if (!assetsInShell.some(url => url.pathname.startsWith('/mikka/assets/')) || assetsInShell.some(url => url.searchParams.get('dpl') !== id)) {
    throw new Error('WEB_RELEASE_ASSET_PIN_MISMATCH')
  }
  return {
    ...common, name: nameForRelease(id), main: resolve(here, 'release.mjs'),
    compatibility_flags: ['nodejs_compat'],
    assets: { directory, binding: 'ASSETS', run_worker_first: true, html_handling: 'none', not_found_handling: 'none' },
    services: [{ binding: 'API', service: api }, { binding: 'CLOUD', service: cloud }],
  }
}

export function gatewayConfig({ current, retained }) {
  if (!Array.isArray(retained) || !retained.includes(current) || new Set(retained).size !== retained.length
      || retained.some(id => !isValidDeploymentId(id) || id !== id.toLowerCase() || !serviceName.test(nameForRelease(id)))) {
    throw new Error('WEB_RELEASE_RETENTION_INVALID')
  }
  const bindings = retained.map((id, index) => [id, `RELEASE_${index}`])
  return {
    ...common, name: 'mikka-app-gateway', main: resolve(here, 'gateway.mjs'),
    vars: { CURRENT_RELEASE: current, RELEASES: Object.fromEntries(bindings) },
    services: bindings.map(([id, binding]) => ({ binding, service: nameForRelease(id) })),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [kind, input, output] = process.argv.slice(2)
  if (!['release', 'gateway'].includes(kind) || !input || !output) throw new Error('WEB_RELEASE_ARGUMENTS_INVALID')
  const config = JSON.parse(await readFile(input, 'utf8'))
  const result = kind === 'release' ? await releaseConfig(config) : gatewayConfig(config)
  await writeFile(output, JSON.stringify(result, null, 2) + '\n')
}
