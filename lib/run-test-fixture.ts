import { daemonTestMode } from '@mikka/protocol/repository'

/** Only the disposable GitHub Actions browser job, or its local run (MIKKA_LOCAL_TEST_ACCOUNTS=1), can request a mock recording. */
export function runTestFixture(harness: string, env: Record<string, string | undefined> = process.env): string | undefined {
  const ci = env.CI === 'true' && env.GITHUB_ACTIONS === 'true'
  if (harness !== 'mock' || !daemonTestMode(env) || env.MIKKA_MVP_E2E !== '1' || !(ci || env.MIKKA_LOCAL_TEST_ACCOUNTS === '1') || env.VERCEL || env.VERCEL_ENV || env.MIKKA_NATIVE_COORDINATOR) return undefined
  try {
    const urls = [env.E2E_DATABASE_URL, env.MIKKA_DATABASE_URL, env.DATABASE_URL].map(value => new URL(value ?? ''))
    if (urls.some(url => !['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/mikka_e2e' || url.search || url.hash)) return undefined
    if (urls.some(url => url.href !== urls[0].href)) return undefined
    return 'mvp-core-loop'
  } catch { return undefined }
}
