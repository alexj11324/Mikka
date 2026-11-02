// The production minute Worker (cloudflare/suggestions-cron) for development:
// pnpm dev:local (scripts/dev-local.mjs) calls the same endpoints on the same
// schedule against the local server, with a local CRON_SECRET (docs/local-runtime.md).
import { runSchedule } from '../../cloudflare/suggestions-cron/src/index.mjs'

/** Runs every minute on the minute; returns a stop function. Failures are logged, never thrown. */
export function startLocalCron({ appUrl, secret, log = console.info, run = runSchedule, now = Date.now, schedule = setTimeout } = {}) {
  let timer = null
  let stopped = false
  const tick = async scheduledTime => {
    try { await run('* * * * *', { MIKKA_URL: appUrl, CRON_SECRET: secret }, fetch, scheduledTime) }
    catch (error) { log(`[local-cron] ${error.message}`) }
  }
  const next = () => {
    if (stopped) return
    const at = Math.floor(now() / 60_000) * 60_000 + 60_000
    timer = schedule(() => { void tick(at).finally(next) }, at - now())
    timer?.unref?.()
  }
  next()
  log(`[local-cron] ${appUrl}/api/cron/* every minute`)
  return () => { stopped = true; if (timer) clearTimeout(timer) }
}
