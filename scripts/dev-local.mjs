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
import { assertDevLocal } from './dev-local/guard.mjs'
import { startLocalCron } from './dev-local/cron.mjs'
import { localSecretsKey } from './dev-local/secrets-key.mjs'
import { grantLocalCredits, localServiceRoutes, LOCAL_CRON_SECRET, LOCAL_RESEND_KEY } from './dev-local/services.mjs'
import { startMvpServices } from '../tests/mvp/services.mjs'
import { MVP_SERVICES, REPOSITORY } from '../tests/mvp/isolated-env.mjs'
import { MVP_DECISION_KEY } from '../tests/mvp/transport.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
for (const file of ['.env.development.local', '.env.local']) if (existsSync(join(root, file))) process.loadEnvFile(join(root, file))
assertDevLocal(process.env)

const port = Number(process.env.MIKKA_DEV_PORT ?? 3000)
const server = `http://localhost:${port}/mikka`
// One synthetic GitHub identity for every local account; the fake grants it write.
const GITHUB_ACCOUNT_ID = '4242'
const daemonUser = process.getuid?.() === 0 ? process.env.MIKKA_DEV_DAEMON_USER : undefined
const children = []
const log = message => console.log(`dev:local ${message}`)

await startMvpServices(3191, { routes: localServiceRoutes({ log, origin: MVP_SERVICES }).routes })
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
log(deepseekKey ? 'model key DEEPSEEK_API_KEY: found' : 'model key: 缺少 DEEPSEEK_API_KEY，跳过模型 key 注入')
async function infisicalSecret(name) {
  const project = process.env.MIKKA_DEV_INFISICAL_PROJECT
  if (!project) return undefined
  const query = new URLSearchParams({ projectId: project, environment: process.env.MIKKA_DEV_INFISICAL_ENV ?? 'dev', secretPath: process.env.MIKKA_DEV_INFISICAL_PATH ?? '/vercel', viewSecretValue: 'true' })
  const headers = process.env.INFISICAL_TOKEN ? { authorization: `Bearer ${process.env.INFISICAL_TOKEN}` } : {}
  const response = await fetch(`https://app.infisical.com/api/v4/secrets/${name}?${query}`, { headers, signal: AbortSignal.timeout(15_000) }).catch(() => null)
  if (!response?.ok) { log(`Infisical ${name}: ${response ? `HTTP ${response.status}` : 'unreachable'}`); return undefined }
  return (await response.json()).secret?.secretValue || undefined
}
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const preload = pathToFileURL(join(root, 'scripts/dev-local/preload.mjs')).href
children.push(spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--port', String(port)], {
  cwd: root, stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'development', NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import ${preload}`.trim(),
    // A real key keeps the real service; without one the preload uses the local substitute.
    AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY || MVP_DECISION_KEY,
    RESEND_API_KEY: process.env.RESEND_API_KEY || LOCAL_RESEND_KEY,
    CRON_SECRET: cronSecret,
    // Saving a workspace's own model key needs it (lib/secrets/crypto.ts).
    WORKSPACE_SECRETS_KEY: secretsKey,
    GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() },
}))

// Plugins › GitHub signs in on github.com; locally each account gets the synthetic identity.
const db = new pg.Pool({ connectionString: process.env.MIKKA_DATABASE_URL ?? process.env.DATABASE_URL, max: 1 })
// Workspaces live in DATABASE_URL (lib/workspace-db.ts); locally usually the same database.
const workspaceDb = process.env.DATABASE_URL && process.env.DATABASE_URL !== process.env.MIKKA_DATABASE_URL ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 }) : db
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
const linking = setInterval(() => {
  linkAccounts().catch(error => log(`link failed: ${error.message}`))
  grantCredits().catch(error => log(`credit grant failed: ${error.message}`))
}, 5000)

for (let i = 0; i < 120; i++) {
  if (await fetch(`${server}/sign-in`).then(r => r.ok, () => false)) break
  await new Promise(r => setTimeout(r, 1000))
}
// Every local account gets the model key through lib/model-api-keys.ts (scripts/dev-local/seed-model-keys.ts).
if (deepseekKey) children.push(spawn(process.execPath, ['--import', './tests/support/server-only.mjs', '--import', 'tsx', 'scripts/dev-local/seed-model-keys-loop.ts'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, WORKSPACE_SECRETS_KEY: secretsKey, DEEPSEEK_API_KEY: deepseekKey },
}))
// The production minute Worker's schedule (cloudflare/suggestions-cron) against this server.
const stopCron = startLocalCron({ appUrl: server, secret: cronSecret, log: line => console.log(`dev:local ${line}`) })
const dataDir = resolve(process.env.MIKKA_DEV_DAEMON_DIR ?? join(root, '.cache/dev-local/daemon'))
// Only the daemon's git sees this rewrite: the GitHub-shaped repository clones and pushes the local
// origin. A config file, because a run's GitHub delivery sets its own GIT_CONFIG_COUNT entries.
const gitConfig = join(dirname(dataDir), 'dev-local.gitconfig')
mkdirSync(dirname(gitConfig), { recursive: true })
writeFileSync(gitConfig, `[url "${pathToFileURL(scenario.barePath).href}"]\n\tinsteadOf = ${REPOSITORY}\n[protocol "file"]\n\tallow = always\n`)
chmodSync(gitConfig, 0o644) // readable by MIKKA_DEV_DAEMON_USER whatever the umask
const tsx = join(root, 'packages/daemon/node_modules/.bin/tsx')
const daemon = args => spawn(daemonUser ? 'setpriv' : tsx,
  daemonUser ? ['--reuid', daemonUser, '--regid', daemonUser, '--init-groups', tsx, ...args] : args, {
    cwd: join(root, 'packages/daemon'), stdio: 'inherit',
    env: { ...process.env, ...(daemonUser ? { HOME: `/home/${daemonUser}` } : {}),
      // File origins are allowed only in local test-account mode (daemonTestMode).
      MIKKA_TEST_MODE: '1', GIT_CONFIG_GLOBAL: gitConfig, GIT_TERMINAL_PROMPT: '0' },
  })
if (!existsSync(join(dataDir, 'device.json'))) {
  log(`sign up at ${server}, then approve this device with the code below`)
  const login = daemon(['bin/mikka.ts', 'daemon', 'login', '--server', server, '--data-dir', dataDir])
  children.push(login)
  await new Promise(r => login.once('exit', r))
}
children.push(daemon(['bin/mikka.ts', 'daemon', '--no-auto-update', '--server', server, '--data-dir', dataDir]))
log(`ready: ${server} — ask the Coordinator to change ${REPOSITORY.replace('https://github.com/', '').replace('.git', '')}`)

const stop = () => { clearInterval(linking); stopCron(); for (const child of children) child.kill('SIGTERM'); void db.end(); if (workspaceDb !== db) void workspaceDb.end(); process.exit(0) }
process.on('SIGINT', stop); process.on('SIGTERM', stop)
