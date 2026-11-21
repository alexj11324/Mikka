import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstat, readFile, readlink, writeFile } from 'node:fs/promises'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildMigrationContext, validateHistoricalMigrations, validateMigrationManifest } from './migration-inputs.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const sha = /^[a-f0-9]{40}$/
const digest = /^sha256:[a-f0-9]{64}$/
export const serviceNames = ['web', 'api', 'eve', 'task', 'world', 'litellm']
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex')
const canonical = value => JSON.stringify(value, Object.keys(value).sort())

function pattern(value) {
  assert.ok(typeof value === 'string' && value && !value.startsWith('/') && !value.split('/').includes('..'))
  let expression = ''
  for (let index = 0; index < value.length; index++) {
    if (value.slice(index, index + 3) === '**/') { expression += '(?:.*/)?'; index += 2 }
    else if (value.slice(index, index + 2) === '**') { expression += '.*'; index++ }
    else if (value[index] === '*') expression += '[^/]*'
    else expression += value[index].replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
  }
  return new RegExp('^' + expression + '$')
}

export async function readBuildInputs(directory = root) {
  const inputs = JSON.parse(await readFile(join(directory, 'config/service-build-inputs.json'), 'utf8'))
  assert.equal(inputs.version, 1)
  assert.deepEqual(Object.keys(inputs.services).sort(), [...serviceNames].sort())
  return inputs
}

function selectedFiles(inputs, service, files) {
  const definition = inputs.services[service]
  assert.ok(definition, 'Unknown release service')
  const include = [...definition.groups.flatMap(group => {
    assert.ok(Array.isArray(inputs.groups[group]), 'Unknown input group')
    return inputs.groups[group]
  }), ...definition.paths].map(pattern)
  const exclude = inputs.exclude.map(pattern)
  const required = (definition.requiredInputs ?? []).map(pattern)
  return files.filter(file => required.some(match => match.test(file))
    || (include.some(match => match.test(file)) && !exclude.some(match => match.test(file)))).sort()
}

export function trackedFiles(directory = root) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: directory, encoding: 'utf8' }).split('\0').filter(Boolean)
}

/** Hash file names, type, executable bit and bytes; never mtime or a release/run ID. */
async function hashFiles(directory, files, parameters) {
  const result = createHash('sha256').update(JSON.stringify(parameters) + '\0')
  for (const file of files) {
    const path = join(directory, file)
    const info = await lstat(path)
    assert.ok(info.isFile() || info.isSymbolicLink(), 'Build inputs must be regular files or links')
    const bytes = info.isSymbolicLink() ? Buffer.from(await readlink(path)) : await readFile(path)
    result.update(JSON.stringify([file, info.isSymbolicLink() ? 'link' : 'file', info.mode & 0o111, bytes.length]) + '\0')
    result.update(bytes)
  }
  return 'sha256:' + result.digest('hex')
}

/** A source plan is not a publication receipt: only a verified build supplies artifact digests. */
export async function buildContexts({ directory = root, inputs, overlayCommit = null, publicSettings = {} } = {}) {
  inputs ??= await readBuildInputs(directory)
  assert.ok(overlayCommit === null || sha.test(overlayCommit))
  const files = trackedFiles(directory)
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim()
  assert.match(sourceCommit, sha)
  const services = {}
  for (const name of serviceNames) {
    const definition = inputs.services[name]
    const selected = selectedFiles(inputs, name, files)
    assert.ok(selected.length > 0, 'Empty service build context')
    const parameters = { version: 1, service: name, definition,
      ...(definition.overlay ? { overlayCommit, publicSettings: canonical(publicSettings) } : {}) }
    services[name] = { kind: definition.kind, contextDigest: await hashFiles(directory, selected, parameters),
      sourceCommit, files: selected, ...(definition.repository ? { repository: definition.repository } : {}) }
  }
  const migrationPatterns = inputs.migrations.map(pattern)
  const migrations = files.filter(file => migrationPatterns.some(match => match.test(file))).sort()
  return { version: 1, sourceCommit, overlayCommit, services,
    migrations: await buildMigrationContext({ directory, files, sqlFiles: migrations }) }
}

function imports(source) {
  const results = new Set()
  const expressions = [
    /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^;'"\n]*(?:\{[^}]*\}[^;'"\n]*)?\s+from\s*)?["']([^"'\n]+)["']/g,
    /\b(?:import|require)\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  ]
  for (const expression of expressions) for (const match of source.matchAll(expression)) results.add(match[1])
  return [...results]
}

/** Follow application imports from actual entry points, including workspace exports. */
export async function assertInputCoverage({ directory = root, inputs } = {}) {
  inputs ??= await readBuildInputs(directory)
  const files = trackedFiles(directory), all = new Set(files), packages = []
  for (const file of files.filter(file => /^(?:packages|apps)\/[^/]+\/package\.json$/.test(file))) {
    const data = JSON.parse(await readFile(join(directory, file), 'utf8'))
    if (data.name) packages.push({ directory: dirname(file), ...data })
  }
  const resolveImport = (specifier, importer) => {
    let path
    if (specifier.startsWith('@/')) path = specifier.slice(2)
    else if (specifier.startsWith('.')) path = posix.normalize(posix.join(posix.dirname(importer), specifier))
    else {
      const workspace = packages.find(item => specifier === item.name || specifier.startsWith(item.name + '/'))
      if (!workspace) return null
      const key = specifier === workspace.name ? '.' : '.' + specifier.slice(workspace.name.length)
      const target = typeof workspace.exports === 'string' ? workspace.exports : workspace.exports?.[key]
      if (typeof target !== 'string') return null
      path = posix.join(workspace.directory, target)
    }
    const base = path.replace(/\.(?:m?js|cjs)$/, '')
    return [path, ...['.ts', '.tsx', '.mjs', '.js', '.json', '/index.ts', '/index.tsx', '/index.mjs', '/index.js'].map(ext => base + ext)].find(file => all.has(file)) ?? null
  }
  const failures = []
  for (const name of serviceNames) {
    const selected = new Set(selectedFiles(inputs, name, files))
    const entries = inputs.services[name].entrypoints.map(pattern)
    const pending = [...selected].filter(file => entries.some(match => match.test(file)) && /\.[cm]?[jt]sx?$/.test(file))
    const visited = new Set()
    for (let index = 0; index < pending.length; index++) {
      const file = pending[index]
      if (visited.has(file)) continue
      visited.add(file)
      const source = await readFile(join(directory, file), 'utf8')
      for (const specifier of imports(source)) {
        const imported = resolveImport(specifier, file)
        if (!imported) continue
        if (!selected.has(imported)) failures.push({ service: name, importer: file, imported })
        else if (/\.[cm]?[jt]sx?$/.test(imported)) pending.push(imported)
      }
    }
  }
  assert.equal(failures.length, 0, 'Service build inputs omit imported files: ' + JSON.stringify(failures))
  return { services: serviceNames.length }
}

export function serviceDigest({ imageDigest = null, artifacts = {} }) {
  if (imageDigest !== null) assert.match(imageDigest, digest)
  const artifactDigests = Object.entries(artifacts).sort(([left], [right]) => left.localeCompare(right)).map(([name, artifact]) => {
    assert.match(artifact.digest, digest)
    return [name, artifact.digest]
  })
  assert.ok(imageDigest !== null || artifactDigests.length > 0, 'A release service must contain a published artifact')
  return hash(JSON.stringify({ imageDigest, artifacts: artifactDigests }))
}

function validateBuild(build) {
  for (const key of ['runId', 'runAttempt', 'artifactId']) assert.match(build?.[key] ?? '', /^[1-9][0-9]*$/)
  assert.match(build.workflow ?? '', /^[a-z0-9-]+\.yml$/)
}

export function validateServiceManifest(name, service) {
  assert.ok(serviceNames.includes(name))
  assert.equal(service.kind, ['web', 'world'].includes(name) ? 'worker' : 'container', name)
  assert.match(service.contextDigest ?? '', digest)
  assert.match(service.sourceCommit ?? '', sha)
  if (['api', 'web'].includes(name)) assert.match(service.overlayCommit ?? '', sha)
  else assert.ok(service.overlayCommit === undefined || service.overlayCommit === null || sha.test(service.overlayCommit))
  assert.equal(typeof service.reused, 'boolean')
  validateBuild(service.build)
  if (service.apiBuild) {
    for (const key of ['runId', 'runAttempt', 'artifactId']) assert.match(service.apiBuild[key] ?? '', /^[1-9][0-9]*$/)
    for (const key of ['sourceCommit', 'overlayCommit']) assert.match(service.apiBuild[key] ?? '', sha)
    for (const key of ['imageDigest', 'workerDigest']) assert.match(service.apiBuild[key] ?? '', digest)
  }
  assert.ok(service.artifacts && typeof service.artifacts === 'object' && !Array.isArray(service.artifacts))
  if (service.kind === 'container') {
    assert.match(service.localImageId ?? '', digest)
    assert.match(service.imageDigest ?? '', digest)
    assert.match(service.image ?? '', /^registry\.cloudflare\.com\/[a-f0-9]{32}\/mikka-[a-z0-9-]+@sha256:[a-f0-9]{64}$/)
    assert.equal(service.image.split('@')[1], service.imageDigest)
  } else assert.equal(service.imageDigest, undefined)
  for (const artifact of Object.values(service.artifacts)) {
    assert.match(artifact.digest ?? '', digest)
    assert.ok(typeof artifact.path === 'string' && /^[a-zA-Z0-9_./-]+$/.test(artifact.path) && !artifact.path.startsWith('/')
      && !artifact.path.split('/').some(part => !part || part === '.' || part === '..' || part === '.git' || part.startsWith('.env')))
    if (artifact.artifactId !== undefined) assert.match(artifact.artifactId, /^[1-9][0-9]*$/)
  }
  assert.equal(service.digest, serviceDigest(service), 'Release service artifact digest differs')
  return service
}

function validateReleaseServices(manifest) {
  assert.equal(manifest?.version, 1)
  assert.match(manifest.sourceCommit ?? '', sha)
  assert.ok(manifest.overlayCommit === null || sha.test(manifest.overlayCommit ?? ''))
  assert.deepEqual(Object.keys(manifest.services ?? {}).sort(), [...serviceNames].sort())
  for (const [name, service] of Object.entries(manifest.services)) validateServiceManifest(name, service)
}

export function validateReleaseManifest(manifest) {
  validateReleaseServices(manifest)
  validateMigrationManifest(manifest.migrations)
  return manifest
}

/** Historical receipts stay unchanged; they cannot authorize a new candidate. */
export function validateHistoricalReleaseManifest(manifest) {
  validateReleaseServices(manifest)
  validateHistoricalMigrations(manifest.migrations)
  return manifest
}

/** Reuse preserves the original source and immutable artifacts, not the new release's commit. */
export function releaseManifest(plan, published, previous = null) {
  if (previous) validateHistoricalReleaseManifest(previous)
  const services = {}
  for (const name of serviceNames) {
    const context = plan.services[name]
    const existing = previous?.services[name]
    if (!published[name] && existing?.contextDigest === context.contextDigest) services[name] = { ...existing, reused: true }
    else {
      assert.ok(published[name], 'No published artifact for changed service: ' + name)
      const result = published[name]
      assert.equal(result.contextDigest, context.contextDigest)
      assert.ok(result.sourceCommit === plan.sourceCommit || result.reused === true, 'An older artifact must be explicitly reused')
      services[name] = { ...result, kind: context.kind, digest: serviceDigest(result), reused: result.reused === true }
    }
  }
  return validateReleaseManifest({ version: 1, sourceCommit: plan.sourceCommit, overlayCommit: plan.overlayCommit,
    services, migrations: plan.migrations })
}

/** Cloudflare Registry implements the OCI Distribution manifest endpoint. Only 404 is a cache miss. */
export async function registryImage({ account, repository, contextDigest, username, password }) {
  assert.match(account ?? '', /^[a-f0-9]{32}$/)
  assert.match(repository ?? '', /^mikka-[a-z0-9-]+$/)
  assert.match(contextDigest ?? '', digest)
  assert.ok(username && password, 'Registry pull credentials required')
  const tag = contextDigest.slice(7)
  const endpoint = 'https://registry.cloudflare.com/v2/' + account + '/' + repository + '/manifests/' + tag
  const response = await fetch(endpoint, { redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { authorization: 'Basic ' + Buffer.from(username + ':' + password).toString('base64'),
      accept: 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' } })
  if (response.status === 404) { await response.body?.cancel(); return null }
  if (response.status !== 200) {
    await response.body?.cancel()
    throw new Error('REGISTRY_LOOKUP_FAILED', { cause: new Error('HTTP_' + response.status) })
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  const imageDigest = hash(bytes)
  assert.equal(response.headers.get('docker-content-digest'), imageDigest, 'Registry manifest digest differs')
  return { image: 'registry.cloudflare.com/' + account + '/' + repository + '@' + imageDigest, imageDigest, tag }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, destination] = process.argv.slice(2)
  if (command === 'check') console.log(JSON.stringify(await assertInputCoverage()))
  else if (command === 'plan' && destination) {
    const result = await buildContexts({ overlayCommit: process.env.OVERLAY_SHA || null,
      publicSettings: JSON.parse(process.env.API_PUBLIC_BUILD_SETTINGS || '{}') })
    await writeFile(resolve(destination), JSON.stringify(result, null, 2) + '\n')
    console.log(JSON.stringify({ sourceCommit: result.sourceCommit,
      services: Object.fromEntries(Object.entries(result.services).map(([name, service]) => [name, service.contextDigest])) }))
  } else throw new Error('Usage: service-builds.mjs check | plan OUTPUT')
}
