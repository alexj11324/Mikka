// A thin scheduler: each cron calls one Mikka endpoint with the shared bearer
// secret and nothing else. All logic stays in the Next.js app, so the
// schedules can move to vercel.json without touching the endpoints.

export const SCHEDULES: Record<string, string> = {
  '*/15 * * * *': '/api/cron/briefings',
  '0 * * * *': '/api/cron/suggestions-reconcile',
}

export interface Env {
  /** Mikka's origin and base path, e.g. https://app.aspectlylabs.com/mikka. */
  MIKKA_URL?: string
  CRON_SECRET?: string
}

interface WorkerSchedule {
  cron: string
}

interface WorkerContext {
  waitUntil(promise: Promise<unknown>): void
}

/** Calls the endpoint for one cron expression; throws on a misconfiguration or a failed call so the run is marked failed. */
export async function runSchedule(cron: string, env: Env, fetcher: typeof fetch = fetch) {
  const path = SCHEDULES[cron]
  if (!path) throw new Error(`No endpoint for cron ${cron}`)
  if (!env.MIKKA_URL || !env.CRON_SECRET) throw new Error('MIKKA_URL and CRON_SECRET must be set')
  const response = await fetcher(`${env.MIKKA_URL.replace(/\/+$/, '')}${path}`, {
    headers: { authorization: `Bearer ${env.CRON_SECRET}` },
    signal: AbortSignal.timeout(90_000),
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`${path} answered ${response.status}`)
  console.log(`${path} ${response.status} ${body.slice(0, 500)}`)
  return response.status
}

export default {
  fetch: () => new Response(null, { status: 404 }),
  scheduled(controller: WorkerSchedule, env: Env, ctx: WorkerContext) {
    ctx.waitUntil(runSchedule(controller.cron, env))
  },
}
