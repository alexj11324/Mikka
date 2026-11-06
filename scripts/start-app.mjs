import { lstat, readFile, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const sha = /^[a-f0-9]{40}$/
const digest = /^[a-f0-9]{64}$/
const fail = code => { throw new Error(code) }

/** Inspect the compiled product before importing any server code or opening a
 * socket. The HTTP attestation performed by acceptance runners remains separate. */
export async function readCompiledBuild(root, { expectedRevision, env = process.env } = {}) {
  root = await realpath(root)
  const output = resolve(root, '.output')
  const manifestPath = resolve(output, 'mikka-build.json')
  const entryPath = resolve(output, 'server/mikka-entry.mjs')
  for (const path of [manifestPath, entryPath]) {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || !(await realpath(path)).startsWith(`${root}${sep}`)) fail('APP_COMPILED_FILE_INVALID')
  }
  const built = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (built.version !== 1 || built.preset !== 'node-server' || built.basePath !== '/mikka'
    || !sha.test(built.revision) || typeof built.node !== 'string' || !built.node.startsWith('v24.') || typeof built.appBuild !== 'string' || !built.appBuild
    || !digest.test(built.lockSha256) || !digest.test(built.routesSha256) || !digest.test(built.tracingSha256)
    || typeof built.testDeploymentSha !== 'string'
    || (built.testDeploymentSha && built.testDeploymentSha !== built.revision)) fail('APP_COMPILED_MANIFEST_INVALID')
  const expected = expectedRevision ?? env.MIKKA_TEST_DEPLOYMENT_SHA
  if (expected !== undefined && (!sha.test(expected) || built.revision !== expected || built.testDeploymentSha !== expected)) fail('APP_COMPILED_REVISION_MISMATCH')
  if (!process.version.startsWith('v24.')) fail('APP_NODE_24_REQUIRED')
  return built
}

/** Public Docker accepts only the same reviewed, non-listening compiled graph.
 * A missing or changed adapter cannot fall back to the ordinary listener. */
export async function readCompiledDockerBuild(root, options = {}) {
  root = await realpath(root)
  const built = await readCompiledBuild(root, options)
  const docker = built.docker
  if (docker?.entry !== 'server/mikka-docker.mjs' || docker.application !== 'server/docker-entry.mjs'
    || docker.trustProxy !== false || !digest.test(docker.entrySha256) || !digest.test(docker.applicationSha256)) fail('APP_COMPILED_DOCKER_INVALID')
  for (const [path, expected] of [[docker.entry, docker.entrySha256], [docker.application, docker.applicationSha256],
    ['server/mikka-tracing.mjs', built.tracingSha256]]) {
    const source = resolve(root, '.output', path)
    const info = await lstat(source)
    if (!info.isFile() || info.isSymbolicLink() || !(await realpath(source)).startsWith(`${root}${sep}`)
      || createHash('sha256').update(await readFile(source)).digest('hex') !== expected) fail('APP_COMPILED_DOCKER_INVALID')
  }
  return built
}

export function serverOptions(args, env = process.env) {
  const options = { hostname: env.NITRO_HOST || env.HOST || '0.0.0.0', port: env.NITRO_PORT || env.PORT || '3000' }
  const seen = new Set()
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]
    if (!['--hostname', '--port', '-H', '-p'].includes(option) || !args[index + 1]) fail('APP_START_ARGUMENT_INVALID')
    const name = ['--port', '-p'].includes(option) ? 'port' : 'hostname'
    if (seen.has(name)) fail('APP_START_ARGUMENT_INVALID')
    seen.add(name); options[name] = args[index + 1]
  }
  if (!/^[0-9]{1,5}$/.test(options.port) || Number(options.port) < 1 || Number(options.port) > 65535) fail('APP_START_PORT_INVALID')
  if (!/^[a-zA-Z0-9.:[\]-]+$/.test(options.hostname)) fail('APP_START_HOST_INVALID')
  return { ...options, port: Number(options.port) }
}

export async function startApp({ root = process.cwd(), args = process.argv.slice(2), env = process.env } = {}) {
  const started = performance.now()
  root = await realpath(root)
  const options = serverOptions(args, env)
  const built = await readCompiledBuild(root, { env })
  // Keep the launch cwd: relative environment descriptors and runtime resources
  // already share this root. In particular, do not move lease files into output.
  if (root !== await realpath(process.cwd())) fail('APP_START_ROOT_MISMATCH')
  process.env.NODE_ENV = 'production'
  process.env.NITRO_HOST = options.hostname
  process.env.NITRO_PORT = String(options.port)
  await import(pathToFileURL(resolve(root, '.output/server/mikka-entry.mjs')).href)
  // The official Node adapter owns listening and graceful shutdown. Readiness
  // uses its actual public, non-authenticated version route, with no DB write.
  const host = options.hostname === '0.0.0.0' ? '127.0.0.1' : ['::', '[::]'].includes(options.hostname) ? '[::1]' : options.hostname
  const url = new URL(`http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${options.port}/mikka/api/version`)
  const deadline = performance.now() + 60_000
  while (performance.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1_500) })
      if (response.ok) {
        const version = await response.json()
        if (version.build !== built.appBuild) fail('APP_RUNTIME_BUILD_MISMATCH')
        console.log(`Ready in ${Math.round(performance.now() - started)}ms`)
        return built
      }
      await response.body?.cancel()
    } catch (error) {
      if (error?.message === 'APP_RUNTIME_BUILD_MISMATCH') throw error
    }
    await delay(100)
  }
  fail('APP_START_TIMEOUT')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await startApp() } catch (error) {
    const code = /^APP_[A-Z0-9_]+$/.test(error?.message ?? '') ? error.message : 'APP_START_FAILED'
    console.error(code)
    // Drain the same process through Nitro's installed shutdown hooks when the
    // failure happened after startup; no other PID or process group is touched.
    process.exitCode = 1
    process.once('exit', () => { process.exitCode = 1 })
    if (process.listenerCount('SIGTERM')) {
      process.kill(process.pid, 'SIGTERM')
      setTimeout(() => process.exit(1), 35_000).unref()
    } else process.exit(1)
  }
}
