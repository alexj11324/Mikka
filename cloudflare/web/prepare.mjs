import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { rendererActionContract } from '../../lib/renderer-actions.mjs'
import { isValidDeploymentId } from '../../lib/deployment-id.mjs'
import { assertNoSourceMaps } from '../../scripts/release/hosted-ui.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const serviceName = /^[a-z][a-z0-9-]{0,62}$/
const nameForRelease = id => `mikka-app-release-${id}`
const common = { compatibility_date: '2026-10-19', workers_dev: false, preview_urls: false }

export async function releaseConfig({ id, assets, api, cloud, sourceSha, overlaySha }) {
  if (!isValidDeploymentId(id) || id !== id.toLowerCase() || !serviceName.test(nameForRelease(id))) throw new Error('WEB_RELEASE_ID_INVALID')
  if (![api, cloud].every(name => typeof name === 'string' && serviceName.test(name)) || api === cloud) {
    throw new Error('WEB_RELEASE_SERVICE_INVALID')
  }
  const sha = /^[a-f0-9]{40}$/
  const prefix = id.split('-')[0]
  if (!sha.test(sourceSha) || !sha.test(overlaySha) || !/^[a-f0-9]{7,12}$/.test(prefix) || !sourceSha.startsWith(prefix)) {
    throw new Error('WEB_RELEASE_REVISION_INVALID')
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
    vars: { RELEASE_SHA: sourceSha, OVERLAY_SHA: overlaySha },
    assets: { directory, binding: 'ASSETS', run_worker_first: true, html_handling: 'none', not_found_handling: 'none' },
    services: [{ binding: 'API', service: api }, { binding: 'CLOUD', service: cloud }],
  }
}

/** Keep the signed build's verification inventory available to the private publisher.
 * Cloudflare receives only the files the official web client can request. */
export async function prepareRelease(input, outputDirectory) {
  const config = await releaseConfig(input)
  const source = config.assets.directory
  const parent = resolve(outputDirectory)
  if (parent === source || parent.startsWith(source + sep)) throw new Error('WEB_RELEASE_OUTPUT_INSIDE_BUILD')
  const published = await mkdtemp(join(parent, 'mikka-web-assets-'))
  try {
    await cp(source, published, { recursive: true, dereference: true, filter(path) {
      const file = relative(source, path)
      return !file.split(sep).some(segment => segment.startsWith('.'))
        && !['renderer-manifest.json', '_headers', '_redirects'].includes(file)
    } })
    const inventory = JSON.parse(await readFile(join(source, 'renderer-manifest.json'), 'utf8'))
    await writeFile(join(published, 'renderer-actions.json'), JSON.stringify(rendererActionContract(inventory)) + '\n')
    config.assets.directory = published
    return config
  } catch (error) {
    await rm(published, { recursive: true, force: true })
    throw error
  }
}

export function gatewayConfig({ current, retained, githubWebhook }) {
  if (!Array.isArray(retained) || !retained.includes(current) || new Set(retained).size !== retained.length
      || retained.some(id => !isValidDeploymentId(id) || id !== id.toLowerCase() || !serviceName.test(nameForRelease(id)))) {
    throw new Error('WEB_RELEASE_RETENTION_INVALID')
  }
  const gateway = 'mikka-app-gateway'
  if (githubWebhook !== undefined && (typeof githubWebhook !== 'string' || !serviceName.test(githubWebhook)
      || githubWebhook === gateway || retained.some(id => githubWebhook === nameForRelease(id)))) {
    throw new Error('WEB_GITHUB_WEBHOOK_SERVICE_INVALID')
  }
  const bindings = retained.map((id, index) => [id, `RELEASE_${index}`])
  const services = bindings.map(([id, binding]) => ({ binding, service: nameForRelease(id) }))
  if (githubWebhook !== undefined) services.push({ binding: 'GITHUB_WEBHOOK', service: githubWebhook })
  return {
    ...common, name: gateway, main: resolve(here, 'gateway.mjs'),
    vars: { CURRENT_RELEASE: current, RELEASES: Object.fromEntries(bindings) },
    services,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [kind, input, output] = process.argv.slice(2)
  if (!['release', 'gateway'].includes(kind) || !input || !output) throw new Error('WEB_RELEASE_ARGUMENTS_INVALID')
  const config = JSON.parse(await readFile(input, 'utf8'))
  const result = kind === 'release' ? await prepareRelease(config, dirname(resolve(output))) : gatewayConfig(config)
  await writeFile(output, JSON.stringify(result, null, 2) + '\n')
}
