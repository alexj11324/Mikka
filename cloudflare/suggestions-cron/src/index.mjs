// Scheduling only: each endpoint handles its own work in Mikka.
export const SCHEDULES = {
  '* * * * *': '/api/cron/coordinator-wakes',
  '*/15 * * * *': '/api/cron/briefings',
  '0 * * * *': '/api/cron/suggestions-reconcile',
  '30 * * * *': '/api/cron/user-facts',
}

export const MINUTE_ENDPOINTS = ['/api/cron/coordinator-wakes', '/api/cron/schedules', '/api/cron/run-recovery']

/** @typedef {{ MIKKA_URL?: string, CRON_SECRET?: string }} Env */

/**
 * @param {string} cron
 * @param {Env} env
 * @param {typeof fetch} [fetcher]
 */
export async function runSchedule(cron, env, fetcher = fetch) {
  const endpoint = SCHEDULES[cron]
  if (!endpoint) throw new Error('Unknown suggestions schedule')
  if (!env.MIKKA_URL || !env.CRON_SECRET) throw new Error('MIKKA_URL and CRON_SECRET must be set')
  const endpoints = cron === '* * * * *' ? MINUTE_ENDPOINTS : [endpoint]
  // Each durable queue must still get its tick when another endpoint fails.
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

export default {
  fetch: () => new Response(null, { status: 404 }),
  /**
   * @param {{ cron: string }} controller
   * @param {Env} env
   * @param {{ waitUntil(promise: Promise<unknown>): void }} ctx
   */
  scheduled(controller, env, ctx) {
    ctx.waitUntil(runSchedule(controller.cron, env))
  },
}
