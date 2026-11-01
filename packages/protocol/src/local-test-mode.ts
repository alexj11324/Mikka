/**
 * Local test mode (docs/test-accounts.md): a developer's own disposable stack on
 * this machine, standing in for the CI job without pretending to be CI. The one
 * rule for the test-account harness, the app (auth origins, signup limits, MVP
 * fixture) and the daemon (mock harness, file:// origins). Pure: no driver, no
 * network. Plain Node imports it too, so it uses only erasable TypeScript.
 */
type Env = Record<string, string | undefined>

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const DATABASE_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/

/** A loopback PostgreSQL URL whose database name ends in _e2e. */
export function localTestDatabaseUrl(value: string): boolean {
  try {
    const url = new URL(value)
    const name = url.pathname.slice(1)
    return (url.protocol === 'postgres:' || url.protocol === 'postgresql:') && LOOPBACK_HOSTS.has(url.hostname)
      && !url.search && !url.hash && DATABASE_NAME.test(name) && name.endsWith('_e2e')
  } catch { return false }
}

/**
 * MIKKA_LOCAL_TEST_ACCOUNTS=1, off any Vercel deployment, E2E_DATABASE_URL set,
 * and every configured application database a loopback *_e2e database.
 */
export function localTestMode(env: Env): boolean {
  if (env.MIKKA_LOCAL_TEST_ACCOUNTS !== '1' || env.VERCEL || env.VERCEL_ENV || !env.E2E_DATABASE_URL) return false
  return [env.E2E_DATABASE_URL, env.MIKKA_DATABASE_URL, env.DATABASE_URL, env.ORVILO_DATABASE_URL]
    .filter((value): value is string => Boolean(value)).every(localTestDatabaseUrl)
}
