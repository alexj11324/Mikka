/** These fixtures must never be pointed at a Preview, a shared DB or production. */
export function assertMvpEnvironment(env = process.env) {
  if (env.CI !== 'true' || env.GITHUB_ACTIONS !== 'true' || env.MIKKA_MVP_E2E !== '1' || env.MIKKA_TEST_MODE !== '1') throw new Error('MVP fixture requires the explicit disposable GitHub Actions job')
  if (env.VERCEL || env.VERCEL_ENV || env.MIKKA_NATIVE_COORDINATOR) throw new Error('MVP fixture cannot run on a deployment or native Coordinator')
  const urls = [env.E2E_DATABASE_URL, env.MIKKA_DATABASE_URL, env.DATABASE_URL].map(value => new URL(value ?? ''))
  if (urls.some(url => !['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/mikka_e2e' || url.search || url.hash) || urls.some(url => url.href !== urls[0].href)) throw new Error('MVP fixture requires the same disposable loopback mikka_e2e database for all targets')
  if (env.E2E_BASE_URL && env.E2E_BASE_URL !== 'http://localhost:3100') throw new Error('MVP fixture cannot use a remote browser target')
}

export const MVP_ORIGIN = 'http://localhost:3100'
export const MVP_SERVICES = 'http://127.0.0.1:3191'
export const REPOSITORY = 'https://github.com/mikka-e2e/core-loop.git'
export const REPOSITORY_KEY = 'v2/github.com/mikka-e2e/core-loop'
