// Public, disposable Docker production runtime. Bootstrap is a separate owning
// harness operation; startup cannot create, adopt or rebind its database.
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { EnvironmentError } from '../../../scripts/test-accounts/database-target.mjs'
import { dockerRequestUrl } from '../../../scripts/test-accounts/docker-ingress.mjs'
import { dockerGatewayRequest, proxyDockerGateway, proxyDockerGatewayUpgrade } from '../../../scripts/test-accounts/docker-gateway.mjs'
import { readCompiledDockerBuild } from '../../../scripts/start-app.mjs'

export function assertDockerBuild(environment, revision, built) {
  if (environment.kind !== 'isolated-docker') throw new EnvironmentError('DOCKER_RUNTIME_DESCRIPTOR_REQUIRED')
  if (environment.deploymentSha !== revision || built?.revision !== revision || built.testDeploymentSha !== revision) throw new EnvironmentError('DOCKER_RUNTIME_COMPILED_REVISION_MISMATCH')
  if (built.version !== 1 || built.preset !== 'node-server' || built.basePath !== environment.basePath
    || built.docker?.trustProxy !== false || built.docker.entry !== 'server/mikka-docker.mjs'
    || built.docker.application !== 'server/docker-entry.mjs') throw new EnvironmentError('DOCKER_RUNTIME_CONFIG_MISMATCH')
}

async function main() {
  const harnessRoot = fileURLToPath(new URL('../../..', import.meta.url))
  const root = process.env.MIKKA_TEST_APP_DIR ? resolve(process.env.MIKKA_TEST_APP_DIR) : harnessRoot
  process.chdir(root)
  process.env.NODE_ENV = 'production'
  process.env.NEXT_TELEMETRY_DISABLED = '1'
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  const built = await readCompiledDockerBuild(root, { expectedRevision: revision })
  // The harness also uses pg to attest its database. Start the same compiled
  // tracer before importing those helpers, not only before the business graph.
  await import(pathToFileURL(resolve(root, '.output/server/mikka-tracing.mjs')).href)
  const [{ Pool }, { assertDatabaseIdentity, loadEnvironment }, { recordRunnerEvidenceSecrets }, { recordAuthenticationSecrets }] = await Promise.all([
    import('pg'), import('../../../scripts/test-accounts/environment.mjs'),
    import('../../../scripts/test-accounts/bootstrap.mjs'), import('../../../scripts/test-accounts/session.mjs'),
  ])
  const environment = await loadEnvironment()
  assertDockerBuild(environment, revision, built)
  if (process.env.AUTH_TRUSTED_ORIGINS && process.env.AUTH_TRUSTED_ORIGINS !== environment.origin) throw new EnvironmentError('DOCKER_RUNTIME_AUTH_ORIGIN_MISMATCH')
  process.env.AUTH_TRUSTED_ORIGINS = environment.origin
  const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 5000 })
  try { await assertDatabaseIdentity(pool, environment) } finally { await pool.end() }
  await recordRunnerEvidenceSecrets(environment)

  const require = createRequire(import.meta.url)
  const workerRequire = createRequire(realpathSync(require.resolve('wrangler/package.json')))
  const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = workerRequire('miniflare')
  const secret = randomBytes(32).toString('hex')
  await recordAuthenticationSecrets([secret], { environment })
  const compiled = await build({ entryPoints: [resolve(root, 'cloudflare/device-gateway/src/index.ts')], bundle: true, format: 'esm', platform: 'neutral', external: ['cloudflare:workers', 'node:crypto'], write: false })
  const options = {
    workers: [{ name: 'desktop-docker-gateway', modules: true, script: compiled.outputFiles[0].text,
      compatibilityDate: '2026-10-22', compatibilityFlags: ['nodejs_compat'],
      durableObjects: { DEVICE_SESSION: { className: 'DeviceSession', useSQLite: true } },
      bindings: { GATEWAY_PUSH_SECRET: secret } }], host: '127.0.0.1', port: 0, cf: false, log: new Log(LogLevel.WARN),
  }
  const worker = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options)
  let app, server
  const sockets = new Set()
  try {
    const gateway = (await worker.ready).origin
    process.env.DEVICE_GATEWAY_PUSH_SECRET = secret
    // Clients use the same real Worker through this one published HTTPS port.
    process.env.DEVICE_GATEWAY_URL = environment.origin
    const { createDockerRuntime } = await import(pathToFileURL(resolve(root, '.output', built.docker.entry)).href)
    app = createDockerRuntime({ origin: environment.origin })
    server = createServer((request, response) => {
      let absolute
      try { absolute = new URL(dockerRequestUrl(request, environment.origin)) }
      catch { response.writeHead(400, { 'cache-control': 'no-store' }); response.end(); return }
      request.url = absolute.pathname + absolute.search
      if (dockerGatewayRequest(request.url, request.method)) { proxyDockerGateway(request, response, gateway); return }
      void app.handle(request, response).catch(() => { if (!response.headersSent) response.writeHead(500); response.end() })
    })
    server.on('upgrade', (request, socket, head) => {
      try {
        const absolute = new URL(dockerRequestUrl(request, environment.origin))
        request.url = absolute.pathname + absolute.search
        if (!dockerGatewayRequest(request.url, request.method, true)) { socket.destroy(); return }
        proxyDockerGatewayUpgrade(request, socket, head, gateway)
      } catch { socket.destroy() }
    })
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(environment.docker.port, '0.0.0.0', resolve) })
    console.log(JSON.stringify({ status: 'ready', revision, origin: environment.origin, environmentId: environment.id, gateway: environment.origin }))
    await new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve) })
  } finally {
    server?.closeAllConnections()
    for (const socket of sockets) socket.destroy()
    if (server?.listening) await new Promise(resolve => server.close(resolve))
    try { await app?.close() } finally { await worker.dispose() }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`Docker test runtime blocked (${error instanceof EnvironmentError ? error.code : 'UNEXPECTED_ERROR'}).`)
    process.exitCode = 1
  })
}
