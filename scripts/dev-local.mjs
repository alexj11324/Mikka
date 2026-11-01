// pnpm dev:local (docs/local-runtime.md): the whole loop on this machine with no
// GitHub. Starts the local fake services (tests/mvp/services.mjs, with the
// substitutes in scripts/dev-local/services.mjs), `next dev` (hot reload) with a
// preload that sends GitHub's API to the fake, and the daemon from source with
// tsx. A workspace's own model key stays real; without a real AI_GATEWAY_API_KEY
// or RESEND_API_KEY, Mikka 默认, Decisions and mail use the local substitutes.
import { spawn, execFileSync } from 'node:child_process'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import pg from 'pg'
import { EnvHttpProxyAgent, fetch as proxyFetch } from 'undici'
import { assertDevLocal } from './dev-local/guard.mjs'
import { startLocalCron } from './dev-local/cron.mjs'
import { localSecretsKey } from './dev-local/secrets-key.mjs'
import { refreshQueue } from './dev-local/refresh-queue.mjs'
import { stopOwnedServices } from './dev-local/shutdown.mjs'
import { prepareLocalHarnesses } from './dev-local/prepare-harnesses.mjs'
import { grantLocalCredits, localServiceRoutes, LOCAL_CRON_SECRET, LOCAL_RESEND_KEY } from './dev-local/services.mjs'
import { startMvpServices } from '../tests/mvp/services.mjs'
import { MVP_SERVICES, REPOSITORY } from '../tests/mvp/isolated-env.mjs'
import { MVP_DECISION_KEY } from '../tests/mvp/transport.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
if (process.env.MIKKA_DEV_SKIP_ENV_FILES !== '1') {
  for (const file of ['.env.development.local', '.env.local']) if (existsSync(join(root, file))) process.loadEnvFile(join(root, file))
}
assertDevLocal(process.env)

const port = Number(process.env.MIKKA_DEV_PORT ?? 3000)
const server = `http://localhost:${port}/mikka`
const dataDir = resolve(process.env.MIKKA_DEV_DAEMON_DIR ?? join(root, '.cache/dev-local/daemon'))
if (process.platform === 'linux' && Buffer.byteLength(join(dataDir, 'local-computer.sock')) >= 108) {
  throw new Error('MIKKA_DEV_DAEMON_DIR is too long for the local daemon Unix socket; use a shorter owned directory')
}
// One synthetic GitHub identity for every local account; the fake grants it write.
const GITHUB_ACCOUNT_ID = '4242'
const daemonUser = process.getuid?.() === 0 ? process.env.MIKKA_DEV_DAEMON_USER : undefined
const children = []
const closers = []
// Child Node processes must use the managed HTTP proxy for real model calls.
// Keep local API/fixture traffic on loopback, preserving inherited exclusions.
const childEnv = { ...process.env, NODE_USE_ENV_PROXY: '1', NO_PROXY: [process.env.NO_PROXY, process.env.no_proxy, 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(',') }
const log = message => console.log(`dev:local ${message}`)
let stopping = false
const stop = (exitCode = 0) => {
  if (stopping) return
  stopping = true
  void stopOwnedServices(children, closers).finally(() => process.exit(typeof exitCode === 'number' ? exitCode : 0))
}
process.on('SIGINT', stop); process.on('SIGTERM', stop)
const failed = error => { log(`local stack failed (${error?.code ?? error?.name ?? 'unknown error'}); stopping owned services`); stop(1) }
process.on('uncaughtException', failed); process.on('unhandledRejection', failed)
const watch = (child, name) => {
  children.push(child)
  child.once('error', () => { if (!stopping) { log(`${name} could not start`); stop(1) } })
  child.once('exit', (code, signal) => { if (!stopping) { log(`${name} exited (${signal ?? code}); stopping local services`); stop(code || 1) } })
  return child
}
let refresh = async () => { throw new Error('local setup is not ready') }
const substitutes = localServiceRoutes({ log, origin: MVP_SERVICES }).routes

const fixtures = await startMvpServices(3191, { routes: async (request, response, url) => {
  // The fixture server is bound to loopback. Acceptance can provision a newly
  // registered account immediately, without waiting for a polling interval.
  if (url.pathname === '/refresh' && request.method === 'POST') {
    try { await refresh(); response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ready: true })) }
    catch { response.writeHead(503, { 'content-type': 'application/json' }); response.end(JSON.stringify({ ready: false })) }
    return true
  }
  return substitutes(request, response, url)
} })
closers.push(() => fixtures.close())
const scenario = await (await fetch(`${MVP_SERVICES}/scenario`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ marker: `mvp-${randomUUID()}`, title: 'dev:local', githubAccountId: GITHUB_ACCOUNT_ID, harness: 'any' }),
})).json()
// Root containers run the daemon as another user (bubblewrap); it must reach the origin.
if (daemonUser) execFileSync('chown', ['-R', daemonUser, dirname(dirname(scenario.barePath))])
log(`fake GitHub on ${MVP_SERVICES}; repository ${REPOSITORY} → ${scenario.barePath} (branch ${scenario.baseBranch})`)

const cronSecret = process.env.CRON_SECRET || LOCAL_CRON_SECRET
// One value for next dev and the model key seeder: what one seals, the other opens.
const secretsKey = process.env.WORKSPACE_SECRETS_KEY || localSecretsKey(join(root, '.cache/dev-local'))
// The workspace model key (DeepSeek preset): from the environment, else by name from Infisical
// (MIKKA_DEV_INFISICAL_PROJECT). Held in memory for the seeder only; never written or printed.
const deepseekKey = process.env.DEEPSEEK_API_KEY || await infisicalSecret('DEEPSEEK_API_KEY')
delete process.env.DEEPSEEK_API_KEY
delete childEnv.DEEPSEEK_API_KEY
log(deepseekKey ? 'model key DEEPSEEK_API_KEY: found' : 'model key: 缺少 DEEPSEEK_API_KEY，跳过模型 key 注入')
async function infisicalSecret(name) {
  const project = process.env.MIKKA_DEV_INFISICAL_PROJECT || process.env.INFISICAL_PROJECT_ID
  if (!project) return undefined
  const api = (process.env.INFISICAL_API_URL || 'https://app.infisical.com').replace(/\/+$/, '')
  const dispatcher = new EnvHttpProxyAgent()
  let token = process.env.INFISICAL_TOKEN
  if (!token && process.env.INFISICAL_CLIENT_ID && process.env.INFISICAL_CLIENT_SECRET) {
    const auth = await proxyFetch(`${api}/api/v1/auth/universal-auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: process.env.INFISICAL_CLIENT_ID, clientSecret: process.env.INFISICAL_CLIENT_SECRET }), signal: AbortSignal.timeout(15_000), dispatcher,
    }).catch(() => null)
    if (!auth?.ok) { log(`Infisical authentication: ${auth ? `HTTP ${auth.status}` : 'unreachable'}`); return undefined }
    token = (await auth.json()).accessToken
  }
  // Local acceptance always reads only the named development model credential.
  const query = new URLSearchParams({ projectId: project, environment: 'dev', secretPath: '/vercel', viewSecretValue: 'true' })
  const headers = token ? { authorization: `Bearer ${token}` } : {}
  const response = await proxyFetch(`${api}/api/v4/secrets/${name}?${query}`, { headers, signal: AbortSignal.timeout(15_000), dispatcher }).catch(() => null)
  if (!response?.ok) { log(`Infisical ${name}: ${response ? `HTTP ${response.status}` : 'unreachable'}`); return undefined }
  return (await response.json()).secret?.secretValue || undefined
}
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const preload = pathToFileURL(join(root, 'scripts/dev-local/preload.mjs')).href
watch(spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--port', String(port)], {
  cwd: root, stdio: 'inherit',
  env: { ...childEnv, NODE_ENV: 'development', NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${preload}`.trim(),
    // A real key keeps the real service; without one the preload uses the local substitute.
    AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY || MVP_DECISION_KEY,
    RESEND_API_KEY: process.env.RESEND_API_KEY || LOCAL_RESEND_KEY,
    CRON_SECRET: cronSecret,
    // Saving a workspace's own model key needs it (lib/secrets/crypto.ts).
    WORKSPACE_SECRETS_KEY: secretsKey,
    GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() },
}), 'next dev')
mkdirSync(dataDir, { recursive: true, mode: 0o700 })
if (daemonUser) execFileSync('chown', [daemonUser, dataDir])
// Download only through the existing official pins and integrity validator.
// This setup overlaps server compilation and finishes before device readiness.
const harnessPreparation = process.env.MIKKA_DEV_SKIP_DAEMON === '1' ? Promise.resolve() : prepareLocalHarnesses({
  root, dataDir, daemonUser, env: childEnv, onChild: child => children.push(child), log,
})
void harnessPreparation.catch(failed)

// Plugins › GitHub signs in on github.com; locally each account gets the synthetic identity.
const db = new pg.Pool({ connectionString: process.env.MIKKA_DATABASE_URL ?? process.env.DATABASE_URL, max: 1 })
// Workspaces live in DATABASE_URL (lib/workspace-db.ts); locally usually the same database.
const workspaceDb = process.env.DATABASE_URL && process.env.DATABASE_URL !== process.env.MIKKA_DATABASE_URL ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 }) : db
closers.push(() => db.end())
if (workspaceDb !== db) closers.push(() => workspaceDb.end())
const linkAccounts = async () => {
  const { rowCount } = await db.query(`INSERT INTO account (id, "accountId", "providerId", "userId", "createdAt", "updatedAt")
    SELECT gen_random_uuid()::text, $1, 'github', u.id, now(), now() FROM "user" u
    WHERE NOT EXISTS (SELECT 1 FROM account a WHERE a."userId" = u.id AND a."providerId" = 'github')`, [GITHUB_ACCOUNT_ID])
  if (rowCount) log(`linked ${rowCount} local account(s) to the synthetic GitHub identity`)
}
// Stripe verifies a card before Mikka 默认 runs; locally every workspace gets a local allowance.
const grantCredits = async () => {
  const count = await grantLocalCredits(db, workspaceDb)
  if (count) log(`granted local credit to ${count} workspace(s)`)
}
let serverReady = false
const readinessDeadline = Date.now() + 120_000
while (Date.now() < readinessDeadline) {
  if (await fetch(`${server}/sign-in`, { signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, readinessDeadline - Date.now()))) }).then(r => r.ok, () => false)) { serverReady = true; break }
  await new Promise(r => setTimeout(r, 1000))
}
if (!serverReady) throw new Error('dev:local server did not become ready')
// Every local account gets the model key through lib/model-api-keys.ts (scripts/dev-local/seed-model-keys.ts).
let seeder
let seederReady
if (deepseekKey) {
  seeder = spawn(process.execPath, ['--import', './tests/support/server-only.mjs', '--import', 'tsx', 'scripts/dev-local/seed-model-keys-loop.ts'], {
    cwd: root, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env: { ...childEnv, WORKSPACE_SECRETS_KEY: secretsKey, DEEPSEEK_API_KEY: deepseekKey },
  })
  watch(seeder, 'model setup')
  seederReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('model setup startup timed out')), 120_000)
    const message = value => { if (value?.type === 'ready') finish() }
    const exited = () => finish(new Error('model setup process stopped'))
    const finish = error => { clearTimeout(timer); seeder.off('message', message); seeder.off('exit', exited); if (error) reject(error); else resolve() }
    seeder.on('message', message); seeder.once('exit', exited)
  })
}
const seedNow = async () => {
  if (!seeder) return
  await seederReady
  const id = randomUUID()
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('model setup timed out')), 120_000)
    const message = value => { if (value?.type === 'refreshed' && value.id === id) finish() }
    const exited = () => finish(new Error('model setup process stopped'))
    const finish = error => { clearTimeout(timer); seeder.off('message', message); seeder.off('exit', exited); if (error) reject(error); else resolve() }
    seeder.on('message', message); seeder.once('exit', exited)
    seeder.send({ type: 'refresh', id }, error => { if (error) finish(error) })
  })
}
// A request after signup must scan after the previous owner's snapshot.
refresh = refreshQueue(() => Promise.all([linkAccounts(), grantCredits(), seedNow()]).then(() => {}))
await refresh()
let periodicRefresh
const linking = setInterval(() => {
  periodicRefresh ??= refresh().catch(() => log('local account setup unavailable; retrying later')).finally(() => { periodicRefresh = undefined })
}, 5000)
closers.push(() => clearInterval(linking))
// Compile the daemon's dynamic handlers before its short live-policy probes.
// Unauthenticated synthetic IDs cannot mutate application state.
const warmId = '00000000-0000-4000-8000-000000000000'
await Promise.all([
  [`/v1/runs/${warmId}/tool-approval`, 'POST'], [`/v1/runs/${warmId}/policy-snapshot`, 'GET'],
  [`/v1/devices/${warmId}/heartbeat`, 'POST'], [`/v1/devices/${warmId}/commands`, 'GET'],
  [`/v1/devices/${warmId}/runs/${warmId}/claim`, 'POST'], ['/api/coordinator/messages', 'POST'], ['/api/mcp', 'POST'],
  [`/v1/runs/${warmId}/events`, 'POST'], [`/v1/runs/${warmId}/checkpoint`, 'POST'], [`/v1/runs/${warmId}/complete`, 'POST'],
  [`/v1/devices/${warmId}/repos`, 'GET'], [`/v1/devices/${warmId}/runs?state=queued`, 'GET'], [`/v1/devices/${warmId}/fs/requests`, 'GET'],
  ['/api/runs/github-token', 'POST'],
].map(async ([path, method]) => {
  await fetch(`${server}${path}`, { method, signal: AbortSignal.timeout(120_000) }).then(response => response.arrayBuffer())
}))
await harnessPreparation
// The production minute Worker's schedule (cloudflare/suggestions-cron) against this server.
const stopCron = startLocalCron({ appUrl: server, secret: cronSecret, log: line => console.log(`dev:local ${line}`) })
closers.push(stopCron)
mkdirSync(join(root, '.cache/dev-local'), { recursive: true })
writeFileSync(join(root, '.cache/dev-local/runtime.json'), JSON.stringify({ version: 1, server, origin: new URL(server).origin, services: MVP_SERVICES, scenario, daemonDataDir: dataDir }, null, 2))
// Only the daemon's git sees this rewrite: the GitHub-shaped repository clones and pushes the local
// origin. A config file, because a run's GitHub delivery sets its own GIT_CONFIG_COUNT entries.
const gitConfig = join(dirname(dataDir), 'dev-local.gitconfig')
mkdirSync(dirname(gitConfig), { recursive: true })
writeFileSync(gitConfig, `[url "${pathToFileURL(scenario.barePath).href}"]\n\tinsteadOf = ${REPOSITORY}\n[protocol "file"]\n\tallow = always\n`)
chmodSync(gitConfig, 0o644) // readable by MIKKA_DEV_DAEMON_USER whatever the umask
const tsx = join(root, 'packages/daemon/node_modules/.bin/tsx')
// Installed after assertDevLocal, outside all agent-writable run/worktree paths.
// The fixed shim only serves this disposable repository on the loopback fake.
const fixtureBin = join(root, '.cache/dev-local/bin')
mkdirSync(fixtureBin, { recursive: true, mode: 0o755 })
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`
writeFileSync(join(fixtureBin, 'gh'), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(root, 'scripts/dev-local/gh.mjs'))} "$@"\n`, { mode: 0o755 })
chmodSync(join(fixtureBin, 'gh'), 0o755)
const daemon = args => spawn(daemonUser ? 'setpriv' : tsx,
  daemonUser ? ['--reuid', daemonUser, '--regid', daemonUser, '--init-groups', tsx, ...args] : args, {
    cwd: join(root, 'packages/daemon'), stdio: 'inherit',
    env: { ...childEnv, PATH: `${fixtureBin}:${childEnv.PATH ?? ''}`, ...(daemonUser ? { HOME: `/home/${daemonUser}` } : {}),
      // File origins are allowed only in local test-account mode (daemonTestMode).
      MIKKA_TEST_MODE: '1', MIKKA_DEV_GIT_ORIGIN: scenario.barePath, GIT_CONFIG_GLOBAL: gitConfig, GIT_TERMINAL_PROMPT: '0' },
  })
if (process.env.MIKKA_DEV_SKIP_DAEMON !== '1') {
  if (!existsSync(join(dataDir, 'device.json'))) {
    log(`sign up at ${server}, then approve this device with the code below`)
    const login = daemon(['bin/mikka.ts', 'daemon', 'login', '--server', server, '--data-dir', dataDir])
    children.push(login)
    const status = await new Promise(r => login.once('exit', r))
    if (status !== 0) throw new Error(`Local daemon login exited with code ${status}`)
  }
  const runningDaemon = daemon(['bin/mikka.ts', 'daemon', '--no-auto-update', '--server', server, '--data-dir', dataDir])
  watch(runningDaemon, 'daemon')
}
log(`ready: ${server} — ask the Coordinator to change ${REPOSITORY.replace('https://github.com/', '').replace('.git', '')}`)
