// Pure helpers shared by the test-account harness and the app's auth origin
// check (lib/auth-config.ts). No database driver or network access here.

const IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/
const LOCAL_DATABASE_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export class EnvironmentError extends Error {
  constructor(code) { super(code); this.name = 'EnvironmentError'; this.code = code }
}
const fail = code => { throw new EnvironmentError(code) }

/** Deliberately never include a URL, driver error, password or response body in errors. */
export function databaseTarget(connectionString) {
  let target
  try { target = new URL(connectionString) } catch { fail('DATABASE_URL_REQUIRED') }
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || target.search || target.hash || !target.username || !target.password) fail('DATABASE_URL_INVALID')
  const name = target.pathname.slice(1)
  if (!IDENTIFIER.test(name) || !IDENTIFIER.test(decodeURIComponent(target.username))) fail('DATABASE_TARGET_INVALID')
  return { host: target.hostname, port: Number(target.port || 5432), name, schema: 'public', user: decodeURIComponent(target.username) }
}

/** A developer's own disposable database: loopback host and a *_e2e name. */
export function localDatabaseTarget(connectionString) {
  const target = databaseTarget(connectionString)
  if (!LOCAL_DATABASE_HOSTS.has(target.host) || !target.name.endsWith('_e2e')) fail('LOCAL_DATABASE_REQUIRED')
  return target
}

/**
 * Local test-account mode (docs/test-accounts.md): MIKKA_LOCAL_TEST_ACCOUNTS=1
 * and every configured application database is a loopback *_e2e database.
 * Off for any other value, a missing E2E_DATABASE_URL or any non-local URL.
 */
export function localTestAccountsMode(env) {
  if (env.MIKKA_LOCAL_TEST_ACCOUNTS !== '1' || !env.E2E_DATABASE_URL) return false
  const urls = [env.E2E_DATABASE_URL, env.MIKKA_DATABASE_URL, env.DATABASE_URL, env.ORVILO_DATABASE_URL].filter(Boolean)
  try { urls.forEach(localDatabaseTarget); return true } catch { return false }
}
