/** Test-only target resolution. Never use either application's database fallback. */
export function improvementTestDatabase(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const required = env.REQUIRE_DB === '1'
  const explicit = env.IMPROVEMENT_TEST_URL
  const ci = env.CI === 'true' && env.GITHUB_ACTIONS === 'true' && required
  const value = explicit ?? (ci ? env.E2E_DATABASE_URL : undefined)
  if (!value) {
    if (required) throw new Error('Self-improvement database is required; refusing to skip')
    return undefined
  }
  const target = new URL(value)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
  const standalone = target.pathname === '/mikka_improvement'
  const sharedCI = !explicit && ci && target.hostname === '127.0.0.1' && target.port === '5432'
    && target.pathname === '/mikka_e2e' && value === env.E2E_DATABASE_URL
    && value === env.MIKKA_DATABASE_URL && value === env.DATABASE_URL
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || !local || target.search || target.hash
    || (!standalone && !sharedCI)) throw new Error('Self-improvement tests require an isolated localhost test database')
  return value
}
