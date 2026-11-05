import { afterJob } from '@/lib/background'
import { liveInvalidations, type LiveInvalidation } from './events'
import { liveChannelId, liveGatewayConfig, type LiveScope } from './scope'

export async function sendLiveInvalidations(scope: LiveScope, events: LiveInvalidation[], env = process.env, send = fetch) {
  const config = liveGatewayConfig(env)
  if (!config || !liveInvalidations(events)) return
  const url = new URL(`/v1/live/${liveChannelId(scope)}/push`, config.url)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await send(url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3_000),
        headers: { authorization: `Bearer ${config.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify(events),
      })
      await response.body?.cancel().catch(() => {})
      if (response.ok) return
      if (response.status < 500 && response.status !== 429) break
    } catch { /* a retry carries the same invalidation keys only */ }
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)))
  }
  console.warn('[live] gateway invalidation unavailable')
}

/** Call only after the owning database transaction has committed. */
export function scheduleLive(work: () => Promise<void>) {
  // after() may invoke this after the request scope has ended. Scope is
  // retained for fresh reads; permissions are still resolved by the work.
  afterJob('after:live-notify', async () => { try { await work() } catch { console.warn('[live] committed invalidation failed') } }, { orRun: true, retainContext: true })
}

export function notifyLive(scope: LiveScope, events: LiveInvalidation[]) {
  scheduleLive(() => sendLiveInvalidations(scope, events))
}
