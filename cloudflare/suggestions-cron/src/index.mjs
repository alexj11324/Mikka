// GitHub's hourly backfill runs in Mikka; this Worker only authenticates the call.
export const SCHEDULE = '0 * * * *'
export const ENDPOINT = '/api/cron/suggestions-reconcile'

/** @typedef {{ MIKKA_URL?: string, CRON_SECRET?: string }} Env */

/**
 * @param {string} cron
 * @param {Env} env
 * @param {typeof fetch} [fetcher]
 */
export async function runSchedule(cron, env, fetcher = fetch) {
  if (cron !== SCHEDULE) throw new Error('Unknown GitHub backfill schedule')
  if (!env.MIKKA_URL || !env.CRON_SECRET) throw new Error('MIKKA_URL and CRON_SECRET must be set')
  let response
  try {
    response = await fetcher(`${env.MIKKA_URL.replace(/\/+$/, '')}${ENDPOINT}`, {
      headers: { authorization: `Bearer ${env.CRON_SECRET}` },
      redirect: 'error',
      signal: AbortSignal.timeout(90_000),
    })
  } catch {
    throw new Error(`${ENDPOINT} request failed`)
  }
  if (!response.ok) throw new Error(`${ENDPOINT} answered ${response.status}`)
  console.log(`${ENDPOINT} ${response.status}`)
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
