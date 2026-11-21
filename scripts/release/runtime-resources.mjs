import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import { POSTER_BINARY_ARCHIVE, POSTER_BINARY_MANIFEST, POSTER_BINARY_MAX_BYTES, POSTER_BINARY_RESOURCE,
  POSTER_LICENSE_FILES, POSTER_RUNTIME_DIRECTORY } from '../../lib/captures/poster-binary.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const compress = promisify(gzip)

/** API and Eve package the same runtime resources without compiling one another. */
export async function runtimeResources(root) {
  const files = ['lib/abuse/data/disposable-email-domains.txt', 'packages/subscription-worker/CPA_COMMIT',
    'packages/daemon/scripts/official-e2b-instance-bootstrap.sh', 'packages/daemon/scripts/refresh-cloud-worker.py',
    'packages/daemon/src/agents/capture-video.mjs']
  for (const item of await readdir(join(root, 'scripts/e2b'), { withFileTypes: true })) {
    if (item.isFile() && /\.(?:py|mjs|sh)$/.test(item.name)) files.push(`scripts/e2b/${item.name}`)
  }
  for (const binary of ['mikka-subscription-worker', 'mikka-subscription-enrollment']) {
    const path = `packages/subscription-worker/bin/${binary}`
    try { if (!(await lstat(join(root, path))).isFile()) throw new Error('API_WORKER_ARTIFACT_INVALID'); files.push(path) }
    catch (error) { if (error.code !== 'ENOENT' || process.env.MIKKA_BUILD_BYOS_WORKER === '1') throw error }
  }
  const resources = await Promise.all(files.map(async path => {
    if (!(await lstat(join(root, path))).isFile()) throw new Error('API_RUNTIME_RESOURCE_INVALID')
    const bytes = await readFile(join(root, path))
    return { path, bytes: bytes.length, sha256: hash(bytes) }
  }))
  const binary = await readFile(join(root, POSTER_BINARY_RESOURCE))
  if (!binary.length || binary.length > POSTER_BINARY_MAX_BYTES) throw new Error('API_POSTER_BINARY_SIZE_INVALID')
  const compressed = await compress(binary, { level: 9 })
  if (compressed.length > POSTER_BINARY_MAX_BYTES) throw new Error('API_POSTER_BINARY_SIZE_INVALID')
  const posterBinary = { version: 1, bytes: binary.length, sha256: hash(binary), gzipBytes: compressed.length, gzipSha256: hash(compressed) }
  const generated = new Map([[POSTER_BINARY_ARCHIVE, compressed], [POSTER_BINARY_MANIFEST, Buffer.from(`${JSON.stringify(posterBinary)}\n`)]])
  for (const name of POSTER_LICENSE_FILES) generated.set(`${POSTER_RUNTIME_DIRECTORY}/${name}`,
    await readFile(join(root, dirname(POSTER_BINARY_RESOURCE), name)))
  for (const [path, bytes] of generated) resources.push({ path, bytes: bytes.length, sha256: hash(bytes) })
  async function copyResources(destinationRoot) {
    await rm(join(destinationRoot, dirname(POSTER_BINARY_RESOURCE)), { recursive: true, force: true })
    for (const resource of resources) {
      const destination = join(destinationRoot, resource.path)
      await mkdir(dirname(destination), { recursive: true })
      if (generated.has(resource.path)) await writeFile(destination, generated.get(resource.path))
      else await cp(join(root, resource.path), destination, { preserveTimestamps: true })
    }
  }
  return { resources, posterBinary, copyResources }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.cwd(), revision = process.env.MIKKA_BUILD_REVISION
  assert.match(revision ?? '', /^[a-f0-9]{40}$/)
  const { resources, posterBinary, copyResources } = await runtimeResources(root)
  await mkdir(join(root, '.output'), { recursive: true })
  await copyResources(join(root, '.output'))
  await writeFile(join(root, '.output/mikka-build.json'), JSON.stringify({ version: 1, revision,
    preset: 'node-server', resources, posterBinary }) + '\n')
}
