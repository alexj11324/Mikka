/** Playwright's waitForFunction considers a returned Promise truthy before it
 * resolves, so an asynchronous IPC predicate can finish on its first null.
 * Poll the actual value in Node and return that same validated public session.
 * Only safe identity is read; this helper never handles a login credential. */
export async function waitForBundledSession(page, expectedId, { timeout = 60_000, interval = 100 } = {}) {
  if (typeof expectedId !== 'string' || !expectedId || !Number.isFinite(timeout) || timeout <= 0 || !Number.isFinite(interval) || interval <= 0) throw new Error('NATIVE_SESSION_WAIT_OPTIONS_INVALID')
  const deadline = performance.now() + timeout
  while (performance.now() < deadline) {
    if (page.isClosed()) throw new Error('NATIVE_SESSION_PAGE_CLOSED')
    let session
    let timer
    try {
      session = await Promise.race([
        page.evaluate(() => window.mikka?.bundled?.session() ?? null),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('NATIVE_SESSION_WAIT_TIMEOUT: the public session IPC did not complete before the deadline')), Math.max(1, deadline - performance.now())) }),
      ])
    } catch (error) {
      // A successful loopback callback navigates the local main frame. Retry
      // that expected context transition; real IPC failures remain failures.
      if (!/Execution context was destroyed|Cannot find context with specified id|Frame was detached/i.test(error.message)) throw error
    } finally { clearTimeout(timer) }
    if (session?.user?.id === expectedId && typeof session?.session?.id === 'string' && session.session.id) return session
    const remaining = deadline - performance.now()
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(interval, remaining)))
  }
  throw new Error('NATIVE_SESSION_WAIT_TIMEOUT: the system-browser handoff did not establish the expected public session before the deadline')
}
