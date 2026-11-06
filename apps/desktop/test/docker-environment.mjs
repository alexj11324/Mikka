// Public, disposable Docker production runtime. Bootstrap is a separate owning
// harness operation; startup cannot create, adopt or rebind its database.
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EnvironmentError } from '../../../scripts/test-accounts/database-target.mjs'
import { dockerRequestUrl } from '../../../scripts/test-accounts/docker-ingress.mjs'
import { dockerGatewayRequest, proxyDockerGateway, proxyDockerGatewayUpgrade } from '../../../scripts/test-accounts/docker-gateway.mjs'
import { readCompiledDockerBuild } from '../../../scripts/start-app.mjs'
import { startLiveWorker } from './live-worker.mjs'

export function assertDockerBuild(environment, revision, built) {
  if (environment.kind !== 'isolated-docker') throw new EnvironmentError('DOCKER_RUNTIME_DESCRIPTOR_REQUIRED')
  if (environment.deploymentSha !== revision || built?.revision !== revision || built.testDeploymentSha !== revision) throw new EnvironmentError('DOCKER_RUNTIME_COMPILED_REVISION_MISMATCH')
  if (built.version !== 1 || built.preset !== 'node-server' || built.basePath !== environment.basePath
    || built.docker?.trustProxy !== false || built.docker.entry !== 'server/mikka-docker.mjs'
    || built.docker.application !== 'server/docker-entry.mjs') throw new EnvironmentError('DOCKER_RUNTIME_CONFIG_MISMATCH')
}

export async function closeDockerResources({ server, sockets, app, worker }, { originalFailure, closeMs = 35_000 } = {}) {
  const failures = []
  try {
    server?.closeAllConnections()
    for (const socket of sockets) socket.destroy()
    if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  } catch (error) { failures.push(error) }
  let timer
  try {
    await Promise.race([Promise.resolve().then(() => app?.close()), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('DOCKER_RUNTIME_APP_CLOSE_TIMEOUT')), closeMs)
    })])
  } catch (error) { failures.push(error) }
  finally { clearTimeout(timer) }
  try { await worker?.close() } catch (error) { failures.push(error) }
  if (failures.length) throw new AggregateError(originalFailure ? [originalFailure, ...failures] : failures, 'DOCKER_RUNTIME_CLOSE_FAILED')
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

  const secret = randomBytes(32).toString('hex')
  await recordAuthenticationSecrets([secret], { environment })
  const stopped = Promise.withResolvers()
  const startupAbort = new AbortController()
  const requestStop = () => { startupAbort.abort(); stopped.resolve() }
  process.once('SIGINT', requestStop)
  process.once('SIGTERM', requestStop)
  let app, server, worker, originalFailure
  const sockets = new Set()
  try {
    worker = await startLiveWorker({ root, secret, name: 'desktop-docker-gateway', signal: startupAbort.signal })
    const gateway = worker.origin
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
    await Promise.race([stopped.promise, worker.failure])
  } catch (error) {
    originalFailure = error
    throw error
  } finally {
    try { await closeDockerResources({ server, sockets, app, worker }, { originalFailure }) }
    finally { process.removeListener('SIGINT', requestStop); process.removeListener('SIGTERM', requestStop) }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`Docker test runtime blocked (${error instanceof EnvironmentError ? error.code : 'UNEXPECTED_ERROR'}).`)
    process.exitCode = 1
    // If a failed SDK close retained handles, fail this owned process instead
    // of leaving a server behind. The database and failed-run evidence remain.
    setTimeout(() => process.exit(1), 5_000).unref()
  })
}
