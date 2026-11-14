import { QUARTER_HOUR, runSchedule } from '../../cloudflare/suggestions-cron/src/schedule.mjs'
import { isCloudEdition } from '../edition'

type Environment = Readonly<Record<string, string | undefined>>

export function schedulerConfig(env: Environment = process.env) {
  if (env.MIKKA_EXTERNAL_CRON === '1' || isCloudEdition(env) || env.VERCEL || !env.BETTER_AUTH_URL || !env.CRON_SECRET) return null
  try {
    const url = new URL(env.BETTER_AUTH_URL)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    return { MIKKA_URL: `${url.origin}/mikka`, CRON_SECRET: env.CRON_SECRET }
  } catch { return null }
}

/** Provides a quarter-hour tick on self-hosted installations. Existing due-timer work remains
 * push-driven and the safety sweep keeps its existing 15 minute cadence. */
export function startBuiltinScheduler(options: {
  env?: Environment
  fetch: typeof fetch
  leader(): Promise<boolean>
  now?: () => number
}) {
  const config = schedulerConfig(options.env)
  if (!config) return { stop() {}, async tick() {} }
  const now = options.now ?? Date.now
  let running = false, stopped = false
  let lastMinute = -1
  const tick = async () => {
    const timestamp = now(), minute = Math.floor(timestamp / 60_000)
    if (stopped || running || minute === lastMinute) return
    lastMinute = minute
    // Every existing recurring job is on a quarter-hour boundary. Empty
    // minutes do no HTTP request and do not query for scheduler leadership.
    if (new Date(timestamp).getUTCMinutes() % 15 !== 0) return
    running = true
    try {
      if (await options.leader()) await runSchedule(QUARTER_HOUR, config, options.fetch, timestamp)
    } catch { console.warn('[builtin-cron] scheduled invocation failed') }
    finally { running = false }
  }
  const timer = setInterval(() => { void tick() }, 60_000)
  timer.unref?.()
  // Running immediately also covers a restart during a due minute.
  void tick()
  return { tick, stop() { stopped = true; clearInterval(timer) } }
}
