// Reproducible isolated production runtime, including the real live Worker.
// Auth/push secrets live in process memory and the test-account scanner's private
// store; no .env file, production connection or external service key is needed.
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { lstat, mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
import { Pool } from 'pg'
import { assertDatabaseIdentity, loadEnvironment } from '../../../scripts/test-accounts/environment.mjs'
import { recordRunnerEvidenceSecrets } from '../../../scripts/test-accounts/bootstrap.mjs'
import { localDatabaseTarget } from '../../../scripts/test-accounts/database-target.mjs'

const harnessRoot = fileURLToPath(new URL('../../..', import.meta.url))
const root = process.env.MIKKA_TEST_APP_DIR ? resolve(process.env.MIKKA_TEST_APP_DIR) : harnessRoot
process.chdir(root)
const require = createRequire(import.meta.url)
const workerRequire = createRequire(realpathSync(require.resolve('wrangler/package.json')))
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = workerRequire('miniflare')
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const database = process.env.E2E_DATABASE_URL
localDatabaseTarget(database)
if (process.env.DATABASE_URL !== database || process.env.MIKKA_DATABASE_URL !== database) throw new Error('DESKTOP_TEST_DATABASE_TARGET_MISMATCH')
const origin = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000'
const hostname = new URL(origin).hostname
const port = Number(new URL(origin).port || 3000)
// NextRequest normalizes 127.x.x.x to localhost. The descriptor must name the
// actual request origin; never relax attestation to accept a different origin.
if (hostname !== 'localhost' || new URL(origin).origin !== origin) throw new Error('DESKTOP_TEST_REQUIRES_CANONICAL_LOCALHOST_ORIGIN')
const secret = randomBytes(32).toString('hex')
Object.assign(process.env, {
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET || randomBytes(32).toString('hex'),
  BETTER_AUTH_URL: origin, MIKKA_LOCAL_TEST_ACCOUNTS: '1',
  MIKKA_TEST_DEPLOYMENT_SHA: sha,
  MIKKA_TEST_ENVIRONMENT_FILE: process.env.MIKKA_TEST_ENVIRONMENT_FILE || '.cache/e2e/environment.json',
  AUTH_TRUSTED_ORIGINS: `${origin},http://127.0.0.1:${port + 1},http://localhost:${port + 1}`,
  NEXT_TELEMETRY_DISABLED: '1', DEVICE_GATEWAY_PUSH_SECRET: secret,
})

await mkdir('.cache/e2e', { recursive: true, mode: 0o700 })
await mkdir('.cache/desktop-runtime', { recursive: true, mode: 0o700 })
const children = []
let worker
let stopping = false
// Miniflare's signal hook calls process.exit synchronously. Its own Worker is
// cleaned there, but an async finally cannot run: kill only our detached Next
// groups on that path. Ordinary command completion still drains them below.
process.once('exit', () => {
  stopping = true
  for (const child of children) signalServer(child, 'SIGKILL')
})
let rejectServerExit
const serverExit = new Promise((_, reject) => { rejectServerExit = reject })
// Startup checks below also observe this promise; attach a handler immediately
// so a failed child during setup cannot become an unhandled rejection.
serverExit.catch(() => {})

async function requireFreePort(serverPort, host) {
  const probe = createServer()
  await new Promise((resolve, reject) => {
    probe.once('error', () => reject(new Error(`DESKTOP_TEST_PORT_${serverPort}_IN_USE`)))
    probe.listen({ port: serverPort, host, exclusive: true }, () => probe.close(resolve))
  })
}

function signalServer(child, signal) {
  if (!child.pid) return
  try {
    // Next may create descendants. Every server has its own process group;
    // teardown must not leave an old build occupying the next run's port.
    process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal)
  } catch (error) { if (error.code !== 'ESRCH') throw error }
}
async function run(command, args, env = process.env) {
  const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  if (code !== 0) throw new Error(`DESKTOP_TEST_SETUP_EXIT_${code}`)
}
async function start(directory, serverPort, label, metrics) {
  const logPath = resolve('.cache/desktop-runtime', `${label}-${sha.slice(0, 12)}-${process.pid}.log`)
  const log = await open(logPath, 'wx', 0o600)
  const env = { ...process.env, ...(metrics ? { MIKKA_DESKTOP_METRICS_SOCKET: `/tmp/mikka-${label}-${process.pid}.sock` } : {}) }
  // Next reconstructs request.url from its listen hostname. Keep it identical
  // to the attested loopback origin, including localhost versus 127.0.0.1.
  const args = [...(metrics ? ['--require', resolve(harnessRoot, 'apps/desktop/test/db-metrics.cjs')] : []), resolve(directory, 'node_modules/next/dist/bin/next'), 'start', '--hostname', hostname, '--port', String(serverPort)]
  const child = spawn(process.execPath, args, { cwd: directory, env, detached: process.platform !== 'win32', stdio: ['ignore', log.fd, log.fd] })
  children.push(child)
  child.once('error', () => rejectServerExit(new Error(`DESKTOP_TEST_${label}_SERVER_FAILED`)))
  child.once('exit', () => { if (!stopping) rejectServerExit(new Error(`DESKTOP_TEST_${label}_SERVER_EXITED`)) })
  await log.close()
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error(`DESKTOP_TEST_${label}_SERVER_EXITED`)
    try {
      const endpoint = new URL('/mikka/api/version', origin)
      endpoint.port = String(serverPort)
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(1500) })
      if (response.ok && child.exitCode === null) return { pid: child.pid, port: serverPort, socket: env.MIKKA_DESKTOP_METRICS_SOCKET, log: logPath }
    } catch { /* bounded startup readiness, never application polling */ }
    await delay(500)
  }
  throw new Error(`DESKTOP_TEST_${label}_SERVER_TIMEOUT`)
}

try {
  const built = JSON.parse(await readFile(resolve('.next/required-server-files.json'), 'utf8'))
  if (built.config?.env?.MIKKA_TEST_BUILD_SHA !== sha) throw new Error('DESKTOP_TEST_COMPILED_REVISION_MISMATCH')
  await requireFreePort(port, '0.0.0.0')
  await requireFreePort(port + 1, '127.0.0.1')
  const compiled = await build({ entryPoints: [resolve('cloudflare/device-gateway/src/index.ts')], bundle: true, format: 'esm', platform: 'neutral', external: ['cloudflare:workers', 'node:crypto'], write: false })
  const options = {
    workers: [{ name: 'desktop-acceptance-gateway', modules: true, script: compiled.outputFiles[0].text,
      compatibilityDate: '2026-10-22', compatibilityFlags: ['nodejs_compat'],
      durableObjects: { DEVICE_SESSION: { className: 'DeviceSession', useSQLite: true } },
      bindings: { GATEWAY_PUSH_SECRET: secret } }], host: '127.0.0.1', port: 0, cf: false, log: new Log(LogLevel.WARN),
  }
  worker = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options)
  process.env.DEVICE_GATEWAY_URL = (await worker.ready).origin
  const existing = await lstat(process.env.MIKKA_TEST_ENVIRONMENT_FILE).then(() => true, error => {
    if (error.code === 'ENOENT') return false
    throw error
  })
  if (existing) {
    // A restart reuses only the exact validated descriptor and existing marker.
    // It never rebinds a database, adopts its users, or installs a missing marker.
    const environment = await loadEnvironment()
    const pool = new Pool({ connectionString: database, max: 1, connectionTimeoutMillis: 5000 })
    try { await assertDatabaseIdentity(pool, environment) } finally { await pool.end() }
    await recordRunnerEvidenceSecrets(environment)
  } else {
    await run(process.execPath, ['scripts/test-accounts/bootstrap.mjs', '--output', process.env.MIKKA_TEST_ENVIRONMENT_FILE])
    await loadEnvironment()
  }
  const bundled = await start(root, port, 'bundled', true)
  const hosted = await start(root, port + 1, 'hosted', true)
  const descriptor = { revision: sha, origin, bundled, hosted, gateway: process.env.DEVICE_GATEWAY_URL, startedAt: new Date().toISOString() }
  await writeFile('.cache/desktop-runtime/processes.json', `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify({ status: 'ready', revision: sha, origin, gateway: descriptor.gateway }))
  const separator = process.argv.indexOf('--')
  if (separator !== -1) {
    const [command, ...args] = process.argv.slice(separator + 1)
    if (!command) throw new Error('DESKTOP_TEST_COMMAND_REQUIRED')
    await Promise.race([run(command, args), serverExit])
  } else {
    await Promise.race([new Promise(resolve => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve) }), serverExit])
  }
} finally {
  stopping = true
  for (const child of children) signalServer(child, 'SIGTERM')
  if (children.length) await delay(1_000)
  for (const child of children) signalServer(child, 'SIGKILL')
  await worker?.dispose()
}
