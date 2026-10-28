/** Only this batch's existing disposable GHA PG service; never a retained DB. */
export function assertPersonalMailboxCITarget(env = process.env) {
  const fail = () => { throw Error('PERSONAL_MAILBOX_DEFAULT_OFF_CI_TARGET_REQUIRED') }
  if (env.CI !== 'true' || env.GITHUB_ACTIONS !== 'true' || env.MIKKA_MAILBOX_DEFAULT_OFF_CI !== '1' || !/^\d+$/.test(env.GITHUB_RUN_ID ?? '')) fail()
  if (env.VERCEL_ENV || env.VERCEL || env.MIKKA_PERSONAL_MAILBOX_ENABLED === '1' || env.MIKKA_NATIVE_COORDINATOR === '1') fail()
  let target
  try { target = new URL(env.E2E_DATABASE_URL) } catch { fail() }
  if (!['postgres:', 'postgresql:'].includes(target.protocol) || target.hostname !== '127.0.0.1' || target.port !== '5432' || target.pathname !== '/mikka_e2e' || target.username !== 'e2e' || !target.password || target.search || target.hash) fail()
  if (env.MIKKA_DATABASE_URL !== env.E2E_DATABASE_URL || env.DATABASE_URL !== env.E2E_DATABASE_URL) fail()
  return { database: 'mikka_e2e', host: '127.0.0.1', port: 5432, role: 'e2e' }
}
