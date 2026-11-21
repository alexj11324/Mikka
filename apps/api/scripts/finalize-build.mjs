import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { build } from 'esbuild'
import { runtimeResources } from '../../../scripts/release/runtime-resources.mjs'
import { configuredDeploymentId } from '../../../lib/deployment-id.mjs'
import { nodeRuntimePackages } from '../build-contract.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
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

/** Called after Nitro and Workflow finish their compiled-output hooks. */
export async function finalizeBuild({ root, output, preset, revision }) {
  root = resolve(root); output = resolve(output)
  if (!within(root, output) || output === root) throw new Error('API_OUTPUT_LOCATION_INVALID')
  if (preset !== 'node-server') throw new Error('API_BUILD_PRESET_UNSUPPORTED')
  const tracing = await compileTracing(root)
  const { resources, posterBinary, copyResources } = await runtimeResources(root)
  const evidence = { version: 1, revision, preset, node: process.version,
    basePath: '/mikka',
    appBuild: process.env.NEXT_PUBLIC_MIKKA_BUILD || revision,
    testDeploymentSha: process.env.MIKKA_TEST_DEPLOYMENT_SHA ?? '',
    lockSha256: hash(await readFile(join(root, 'pnpm-lock.yaml'))),
    routesSha256: hash(await readFile(join(root, 'apps/api/generated/routes.json'))),
    tracingSha256: hash(tracing), posterBinary, resources }
  if (evidence.testDeploymentSha && evidence.testDeploymentSha !== revision) throw new Error('API_TEST_BUILD_SHA_MISMATCH')
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
  await writeFile(join(output, 'mikka-build.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  return evidence
}
