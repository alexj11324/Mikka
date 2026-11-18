import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { gzip } from 'node:zlib'
import { build } from 'esbuild'
import { POSTER_BINARY_ARCHIVE, POSTER_BINARY_MANIFEST, POSTER_BINARY_MAX_BYTES, POSTER_BINARY_RESOURCE,
  POSTER_LICENSE_FILES, POSTER_RUNTIME_DIRECTORY } from '../../../lib/captures/poster-binary.mjs'
import { configuredDeploymentId } from '../../../lib/deployment-id.mjs'
import { nodeRuntimePackages } from '../build-contract.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const compress = promisify(gzip)
const within = (root, path) => path === root || path.startsWith(`${root}${sep}`)

/** Compile app-owned tracing only; the actual pg/OTel packages stay external. */
export async function compileTracing(root) {
  const result = await build({
    absWorkingDir: root, entryPoints: ['apps/api/runtime/tracing-start.ts'],
    bundle: true, platform: 'node', format: 'esm', target: 'node22',
    alias: { '@': root }, external: nodeRuntimePackages, write: false, metafile: true,
    sourcemap: false,
  })
  if (Object.keys(result.metafile.inputs).some(path => /(?:^|\/)node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(?:pg|@opentelemetry\/)/.test(path))) throw new Error('API_TRACING_EXTERNALS_BUNDLED')
  return result.outputFiles[0].contents
}

async function runtimeFiles(root) {
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
  return files
}

/** Called after Nitro and Workflow finish their compiled-output hooks. */
export async function finalizeBuild({ root, output, preset, revision }) {
  root = resolve(root); output = resolve(output)
  if (!within(root, output) || output === root) throw new Error('API_OUTPUT_LOCATION_INVALID')
  if (preset !== 'node-server') throw new Error('API_BUILD_PRESET_UNSUPPORTED')
  const tracing = await compileTracing(root)
  const files = await runtimeFiles(root)
  const resources = await Promise.all(files.map(async path => {
    const source = join(root, path)
    if (!(await lstat(source)).isFile()) throw new Error('API_RUNTIME_RESOURCE_INVALID')
    const bytes = await readFile(source)
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
    // Remove any traced/raw copy (or package symlink). Generated resources live
    // outside node_modules so Docker retains its server/node_modules symlink.
    await rm(join(destinationRoot, dirname(POSTER_BINARY_RESOURCE)), { recursive: true, force: true })
    for (const resource of resources) {
      const destination = join(destinationRoot, resource.path)
      await mkdir(dirname(destination), { recursive: true })
      if (generated.has(resource.path)) await writeFile(destination, generated.get(resource.path))
      else await cp(join(root, resource.path), destination, { preserveTimestamps: true })
    }
  }
  const evidence = { version: 1, revision, preset, node: process.version,
    basePath: '/mikka',
    appBuild: process.env.NEXT_PUBLIC_MIKKA_BUILD || revision,
    testDeploymentSha: process.env.MIKKA_TEST_DEPLOYMENT_SHA ?? '',
    lockSha256: hash(await readFile(join(root, 'pnpm-lock.yaml'))),
    routesSha256: hash(await readFile(join(root, 'apps/api/generated/routes.json'))),
    tracingSha256: hash(tracing), posterBinary, resources }
  if (evidence.testDeploymentSha && evidence.testDeploymentSha !== revision) throw new Error('API_TEST_BUILD_SHA_MISMATCH')
  {
    evidence.overlaySha = process.env.MIKKA_UI_OVERLAY_SHA || null
    evidence.deploymentId = configuredDeploymentId() ?? null
    if (process.env.MIKKA_EDITION === 'cloud' && evidence.overlaySha && evidence.deploymentId) {
      const { buildCloudflareWorld } = await import('../../../scripts/build-cloudflare-world.mjs')
      const path = 'world-business.mjs'
      const file = await buildCloudflareWorld('business', join(output, path))
      evidence.businessWorld = { path, sha256: hash(await readFile(file)) }
    }
    const server = join(output, 'server')
    await readFile(join(server, 'index.mjs'))
    const dockerApplication = await readFile(join(server, 'docker-entry.mjs'))
    await writeFile(join(server, 'mikka-tracing.mjs'), tracing)
    await writeFile(join(server, 'mikka-entry.mjs'), 'import "./mikka-tracing.mjs"\nawait import("./index.mjs")\n')
    const dockerEntry = 'import "./mikka-tracing.mjs"\nconst application = await import("./docker-entry.mjs")\nexport const createDockerRuntime = application.createDockerRuntime\n'
    await writeFile(join(server, 'mikka-docker.mjs'), dockerEntry)
    evidence.docker = { entry: 'server/mikka-docker.mjs', application: 'server/docker-entry.mjs',
      entrySha256: hash(dockerEntry), applicationSha256: hash(dockerApplication), trustProxy: false }
    // Node deployments are self-contained too. Existing process.cwd() resource
    // paths are retained when starting from this output directory.
    await copyResources(output)
  }
  await writeFile(join(output, 'mikka-build.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  return evidence
}
