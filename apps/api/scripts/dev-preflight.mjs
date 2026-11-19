import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import pg from 'pg'

/**
 * `pnpm dev` is the one command a developer should need. Two things used to be
 * manual and failed later with an opaque error instead: a database (nothing
 * created or migrated it, so the first request died on a missing table) and the
 * official UI overlay (a public checkout serves only the sign-in documents, and
 * signing in then threw `SERVER_DOCUMENT_CANNOT_LOAD_WORKSPACE` from inside a
 * React boundary). This module decides both before any server starts and says
 * in one line what it did.
 */

/** Loopback only: a development server never creates or migrates a remote database. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export const DEFAULT_DEVELOPMENT_DATABASE = 'postgres://postgres@127.0.0.1:5432/mikka_dev'

function isLoopback(url) {
  try {
    const target = new URL(url)
    return ['postgres:', 'postgresql:'].includes(target.protocol) && LOOPBACK.has(target.hostname)
  } catch { return false }
}

/** A database URL the environment already names wins; nothing is rewritten. */
export function configuredDatabase(env) {
  const named = env.MIKKA_DATABASE_URL ?? env.DATABASE_URL
  return named?.trim() ? { url: named.trim(), source: 'environment' } : null
}

function connect(databaseUrl) {
  return new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 3000 })
}

async function reachable(databaseUrl) {
  const pool = connect(databaseUrl)
  try { await pool.query('select 1'); return true }
  catch { return false }
  finally { await pool.end().catch(() => {}) }
}

async function ensureDatabase(databaseUrl) {
  const target = new URL(databaseUrl)
  const name = target.pathname.replace(/^\//, '')
  if (!name) return false
  const server = new URL(databaseUrl)
  server.pathname = '/postgres'
  const pool = connect(server.toString())
  try {
    const found = await pool.query('select 1 from pg_database where datname = $1', [name])
    if (found.rowCount) return false
    await pool.query(`create database "${name.replace(/"/g, '""')}"`)
    return true
  } finally { await pool.end().catch(() => {}) }
}

function migrated(databaseUrl) {
  const pool = connect(databaseUrl)
  return pool.query('select 1 from information_schema.tables where table_name = $1', ['schema_migrations'])
    .then(result => result.rowCount > 0)
    .catch(() => false)
    .finally(() => pool.end().catch(() => {}))
}

function migrate(root, databaseUrl) {
  execFileSync(process.execPath, ['scripts/migrate.mjs'], {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: databaseUrl, MIKKA_DATABASE_URL: databaseUrl, MIGRATE: '1' },
  })
}

/**
 * Decides the database and the overlay, and returns the environment every child
 * process gets. Throws a readable error instead of letting the first request
 * fail: an unreachable local PostgreSQL, or a database URL that is not loopback.
 */
export async function prepareDevelopment({ root, env = process.env, log = () => {} } = {}) {
  const configured = configuredDatabase(env)
  const databaseUrl = configured?.url ?? DEFAULT_DEVELOPMENT_DATABASE
  // A URL the developer named is theirs: migrate it, but say out loud that it is
  // not this machine. The default is loopback, so the silent path is the safe one.
  if (configured && !isLoopback(databaseUrl)) log(`[dev] MIKKA_DATABASE_URL is not loopback (${new URL(databaseUrl).hostname}); this server will use it as given`)

  const serverUp = await reachable(databaseUrl)
  if (!serverUp) {
    const serverOnly = new URL(databaseUrl)
    serverOnly.pathname = '/postgres'
    if (!(await reachable(serverOnly.toString()))) throw new Error(
      `DEV_DATABASE_UNREACHABLE: no PostgreSQL at ${new URL(databaseUrl).host}. Start one (brew services start postgresql@17) or set MIKKA_DATABASE_URL.`)
    if (!isLoopback(databaseUrl)) throw new Error(
      `DEV_DATABASE_MISSING: ${new URL(databaseUrl).pathname.slice(1)} does not exist on ${new URL(databaseUrl).host}; \`pnpm dev\` creates a database only on this machine. Create it, or set MIKKA_DATABASE_URL.`)
  }

  const created = serverUp ? false : await ensureDatabase(databaseUrl)
  if (created) log(`[dev] created database ${new URL(databaseUrl).pathname.slice(1)}`)
  if (created || !(await migrated(databaseUrl))) {
    log('[dev] applying migrations')
    migrate(root, databaseUrl)
  }

  const overlayDirectory = env.MIKKA_UI_OVERLAY_DIR?.trim() || (existsSync(join(root, '.hosted-ui')) ? '.hosted-ui' : '')
  const overlay = overlayStatus(root, overlayDirectory)
  for (const line of overlay.notes) log(`[dev] ${line}`)

  return {
    env: {
      ...env,
      MIKKA_DATABASE_URL: databaseUrl,
      DATABASE_URL: databaseUrl,
      E2E_DATABASE_URL: env.E2E_DATABASE_URL ?? databaseUrl,
      // A loopback database is this machine's own; the raised sign-up limit and
      // the prepared account exist so a developer can get into the app without
      // tripping the production abuse limits while working on UI.
      ...(isLoopback(databaseUrl) ? { MIKKA_LOCAL_TEST_ACCOUNTS: env.MIKKA_LOCAL_TEST_ACCOUNTS ?? '1' } : {}),
      ...(overlayDirectory ? { MIKKA_UI_OVERLAY_DIR: overlayDirectory } : {}),
    },
    databaseUrl,
    overlay,
  }
}

/** What the frontend will be able to render, decided before the server starts. */
export function overlayStatus(root, directory) {
  if (!directory) return {
    installed: false,
    notes: ['no .hosted-ui checkout: this server renders the sign-in, consent and handoff documents only. Clone mikka-hosted-ui to .hosted-ui for the full workspace.'],
  }
  const absolute = directory.startsWith('/') ? directory : join(root, directory)
  if (!existsSync(absolute)) return {
    installed: false,
    notes: [`MIKKA_UI_OVERLAY_DIR points at ${directory}, which does not exist; the workspace will not render.`],
  }
  if (!existsSync(join(absolute, 'node_modules'))) return {
    installed: false,
    missingDependencies: true,
    notes: [`${directory} has no node_modules; installing its own dependencies (pnpm install --ignore-workspace).`],
  }
  return { installed: true, notes: [`serving the official UI from ${directory}`] }
}

/** The overlay is a separate pnpm project: the parent workspace must not claim it. */
export function installOverlay(absolute) {
  execFileSync('pnpm', ['install', '--ignore-workspace', '--frozen-lockfile'], { cwd: absolute, stdio: 'inherit' })
}

/**
 * The local account. Its password is generated on this machine and kept in a
 * gitignored file, never in the source: a literal password in a commit is a
 * secret finding (GitGuardian flags one), and a shared default would also mean
 * every checkout of this repository had the same working credential.
 */
export const DEVELOPMENT_ACCOUNT_EMAIL = 'dev@mikka.local'

export function developmentAccountFile(root) {
  return join(root, '.cache/dev-runtime/dev-account.json')
}

export function readDevelopmentAccount(root) {
  const file = developmentAccountFile(root)
  try { return { ...JSON.parse(readFileSync(file, 'utf8')), file } } catch { return null }
}

function writeDevelopmentAccount(root, account) {
  const file = developmentAccountFile(root)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify({ email: account.email, password: account.password }, null, 1)}\n`, { mode: 0o600 })
  return file
}

/**
 * Creates the local account once, so a person opening the app does not have to
 * sign up (and is not held by the sign-up rate limit). Only a loopback server
 * gets this; the account is an ordinary row in the local database.
 */
export async function provisionDevelopmentAccount(root, origin, log = () => {}) {
  const base = origin.replace(/\/$/, '')
  const stored = readDevelopmentAccount(root)
  const account = stored ?? { email: DEVELOPMENT_ACCOUNT_EMAIL, password: randomBytes(24).toString('base64url') }
  const response = await fetch(`${base}/api/auth/sign-up/email`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '本地开发者', email: account.email, password: account.password }),
  }).catch(() => null)
  if (!response) return { created: false, reason: 'unreachable' }
  if (response.ok) {
    const file = stored ? stored.file : writeDevelopmentAccount(root, account)
    log(`[dev] local account created: ${account.email} / ${account.password} (kept in ${file})`)
    return { created: true, ...account }
  }
  if (stored) {
    log(`[dev] local account exists: ${account.email}; its password is in ${stored.file}`)
    return { created: false, reason: String(response.status), ...account }
  }
  log(`[dev] ${account.email} already exists in this database with a password this script does not know. Delete that row, or set MIKKA_DEV_PASSWORD and re-run.`)
  return { created: false, reason: String(response.status) }
}

