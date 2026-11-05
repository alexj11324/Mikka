// Scheduling only: each endpoint handles its own work in Mikka.
export const SCHEDULES = {
  '* * * * *': '/api/cron/coordinator-wakes',
  '*/15 * * * *': '/api/cron/briefings',
  '0 * * * *': '/api/cron/suggestions-reconcile',
  '30 * * * *': '/api/cron/user-facts',
}

/**
 * Reconciliation sweeps, in minutes between runs. Their work starts from the
 * write that makes it due and wakes at its due time (#1212); a sweep only
 * recovers a start that was lost (the process died between COMMIT and start).
 * - coordinator-wakes 5: a lost start is a person's unanswered message, so it
 *   gets the shortest catch-up inside the 5-15 min range.
 * - schedules 10: occurrences, retries and leases run on the schedules due
 *   timer at their persisted time; a lost start is a timer start lost after a
 *   create, update, resume or failed read, rare enough for a 10 min catch-up.
 * - run-recovery 15: lease expiries, outcome judging, kill and group-turn
 *   retries, machine checks and the Factory watchdog run on the run-recovery
 *   due timer at their persisted times, and every pass re-reads all of them,
 *   so while any run is leased the timer is already running. A lost arm only
 *   matters on an otherwise idle system; 15 min is the top of the range.
 */
export const SWEEP_MINUTES = {
  '/api/cron/coordinator-wakes': 5,
  '/api/cron/schedules': 10,
  '/api/cron/run-recovery': 15,
}

export const MINUTE_ENDPOINTS = Object.keys(SWEEP_MINUTES)

/** The sweeps due in this UTC minute, in MINUTE_ENDPOINTS order. */
export function sweepsAt(minute) {
  return MINUTE_ENDPOINTS.filter(path => minute % SWEEP_MINUTES[path] === 0)
}

/** @typedef {{ MIKKA_URL?: string, CRON_SECRET?: string }} Env */

/**
 * @param {string} cron
 * @param {Env} env
 * @param {typeof fetch} [fetcher]
 * @param {number} [scheduledTime]
 */
export async function runSchedule(cron, env, fetcher = fetch, scheduledTime = Date.now()) {
  const endpoint = SCHEDULES[cron]
  if (!endpoint) throw new Error('Unknown suggestions schedule')
  if (!env.MIKKA_URL || !env.CRON_SECRET) throw new Error('MIKKA_URL and CRON_SECRET must be set')
  // Cloudflare supplies the scheduled timestamp, so a delayed invocation
  // still runs the original UTC quarter-hour/hour/half-hour work.
  const minute = new Date(scheduledTime).getUTCMinutes()
  const endpoints = cron === '* * * * *' ? sweepsAt(minute) : [endpoint]
  if (cron === '* * * * *') {
    if (minute === 0) endpoints.push('/api/cron/account-deletions', '/api/cron/audit-retention')
    if (minute % 15 === 0) endpoints.push('/api/cron/ops-monitor')
    // Abandoned subscription sign-ins and their secret artifacts: maintenance with no single event (#1371).
    if (minute === 0) endpoints.push('/api/cron/subscriptions')
    if (minute % 15 === 0) endpoints.push(SCHEDULES['*/15 * * * *'])
    if (minute === 0) endpoints.push(SCHEDULES['0 * * * *'])
    if (minute === 30) endpoints.push(SCHEDULES['30 * * * *'])
  }
  // Each durable queue must still get its tick when another endpoint fails.
  const results = await Promise.allSettled(endpoints.map(path => runEndpoint(path, env, fetcher)))
  const failed = results.find(result => result.status === 'rejected')
  if (failed) throw failed.reason
  // A minute with no endpoint due (every sweep slower than 1 min) makes no request.
  return results[0]?.value ?? null
}

async function runEndpoint(endpoint, env, fetcher) {
  let response
  try {
    response = await fetcher(`${env.MIKKA_URL.replace(/\/+$/, '')}${endpoint}`, {
      headers: { authorization: `Bearer ${env.CRON_SECRET}` },
      // Workers supports manual redirects; non-2xx responses are rejected below.
      redirect: 'manual',
      signal: AbortSignal.timeout(90_000),
    })
  } catch {
    throw new Error(`${endpoint} request failed`)
  }
  if (!response.ok) throw new Error(`${endpoint} answered ${response.status}`)
  let summary
  try { summary = await response.json() }
  catch { throw new Error(`${endpoint} returned invalid JSON`) }
  const counts = {}
  for (const key of ['zones', 'due', 'written', 'empty', 'skipped', 'failed', 'deferred', 'pushed', 'people', 'started', 'exhausted', 'materialized', 'executed', 'reported', 'owners']) {
    const value = summary?.[key]
    if (Number.isSafeInteger(value) && value >= 0) counts[key] = value
  }
  console.log(`${endpoint} ${response.status} ${JSON.stringify(counts)}`)
  return response.status
}

export default {
  fetch: () => new Response(null, { status: 404 }),
  /**
   * @param {{ cron: string; scheduledTime: number }} controller
   * @param {Env} env
   * @param {{ waitUntil(promise: Promise<unknown>): void }} ctx
   */
  scheduled(controller, env, ctx) {
    ctx.waitUntil(runSchedule(controller.cron, env, fetch, controller.scheduledTime))
  },
}
