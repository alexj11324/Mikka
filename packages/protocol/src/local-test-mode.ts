/**
 * Local test-account mode (docs/test-accounts.md): a developer's own disposable
 * stack on this machine, standing in for the CI job without pretending to be CI.
 * The one rule for the test-account harness (re-exported by
 * scripts/test-accounts/database-target.mjs), the app (auth origins, signup
 * limits, MVP fixture) and the daemon (MIKKA_TEST_MODE). Pure: no driver, no
 * network. Plain Node imports it too, so it uses only erasable TypeScript.
 */
type Env = Record<string, string | undefined>

const IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * A PostgreSQL URL the harness can bind (user, password, plain identifiers, no
 * query or fragment) on a loopback host, whose database name ends in _e2e.
 */
export function localTestDatabaseUrl(value: string): boolean {
  try {
    const url = new URL(value)
    const name = url.pathname.slice(1)
    return (url.protocol === 'postgres:' || url.protocol === 'postgresql:') && !url.search && !url.hash
      && Boolean(url.username) && Boolean(url.password) && IDENTIFIER.test(name) && IDENTIFIER.test(decodeURIComponent(url.username))
      && LOOPBACK_HOSTS.has(url.hostname) && name.endsWith('_e2e')
  } catch { return false }
}

/**
 * MIKKA_LOCAL_TEST_ACCOUNTS exactly '1', no VERCEL or VERCEL_ENV, E2E_DATABASE_URL
 * set, and every configured application database a local test database.
 */
export function localTestAccountsMode(env: Env): boolean {
  if (env.MIKKA_LOCAL_TEST_ACCOUNTS !== '1' || env.VERCEL || env.VERCEL_ENV || !env.E2E_DATABASE_URL) return false
  return [env.E2E_DATABASE_URL, env.MIKKA_DATABASE_URL, env.DATABASE_URL, env.ORVILO_DATABASE_URL]
    .filter((value): value is string => Boolean(value)).every(localTestDatabaseUrl)
}
