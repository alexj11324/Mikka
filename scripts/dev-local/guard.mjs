import { localTestAccountsMode } from '../test-accounts/database-target.mjs'

/**
 * `pnpm dev:local` (docs/local-runtime.md): a developer's own machine, with the
 * reviewed local test-account check (MIKKA_LOCAL_TEST_ACCOUNTS=1, E2E_DATABASE_URL
 * set, every database a loopback *_e2e). Never on a deployment or a production build.
 */
export function devLocalMode(env) {
  if (env.VERCEL || env.VERCEL_ENV || env.NODE_ENV === 'production') return false
  return localTestAccountsMode(env)
}

export function assertDevLocal(env) {
  if (!devLocalMode(env)) throw new Error('dev:local needs MIKKA_LOCAL_TEST_ACCOUNTS=1 and loopback *_e2e databases (E2E_DATABASE_URL set), off any deployment')
}
