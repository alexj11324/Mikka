// The single native trigger supplies all existing UTC quarter-hour deliveries.
export const QUARTER_HOUR = '0,15,30,45 * * * *'
const legacyMinute = '* * * * *'
const suggestions = '/api/cron/suggestions-reconcile'
const facts = '/api/cron/user-facts'

/** @typedef {{ MIKKA_URL?: string, CRON_SECRET?: string }} Env */

/**
 * @param {string} cron
 * @param {Env} env
 * @param {typeof fetch} [fetcher]
 * @param {number} [scheduledTime]
 */
export async function runSchedule(cron, env, fetcher = fetch, scheduledTime = Date.now()) {
  if (!env.MIKKA_URL || !env.CRON_SECRET) throw new Error('MIKKA_URL and CRON_SECRET must be set')
  let endpoints
  if (cron === QUARTER_HOUR || cron === legacyMinute) {
    const minute = new Date(scheduledTime).getUTCMinutes()
    // Cloudflare can still deliver the previous trigger while a change propagates.
    if (cron === legacyMinute && minute % 15 !== 0) return null
    endpoints = ['/api/cron/reconcile', '/api/cron/ops-monitor', '/api/cron/briefings']
    if (minute === 0) endpoints.push('/api/cron/subscriptions', suggestions)
    if (minute === 30) endpoints.push(facts)
  } else if (cron === '*/15 * * * *') endpoints = ['/api/cron/briefings']
  else if (cron === '0 * * * *') endpoints = [suggestions]
  else if (cron === '30 * * * *') endpoints = [facts]
  else throw new Error('Unknown suggestions schedule')
  // Complete all independent endpoint deliveries before reporting an error to Cron.
  const results = await Promise.allSettled(endpoints.map(path => runEndpoint(path, env, fetcher)))
  const failed = results.find(result => result.status === 'rejected')
  if (failed) throw failed.reason
  return results[0].value
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
