import { afterJob } from '@/lib/background'
import { liveInvalidations, withoutRevisions, type LiveInvalidation } from './events'
import { liveGatewayConfig, type LiveScope } from './scope'
import { gatewayConfig, gatewayURL } from '../builtin-gateway/config'
import { LIVE_REVOKE } from './revocation'

/** The Worker deploys after the app (.github/workflows/device-gateway.yml). An
 * older Worker refuses a revision field, so this instance sends plain keys for a while. */
const PLAIN_AFTER_REFUSAL_MS = 10 * 60_000
let plainUntil = 0
export function resetLiveRevisionFallback() { plainUntil = 0 }

export async function sendLiveInvalidations(scope: LiveScope, events: LiveInvalidation[], env = process.env, send = fetch, now = Date.now) {
  const config = liveGatewayConfig(env)
  if (!config || !liveInvalidations(events, true)) return
  const { sendEnterpriseLiveInvalidations } = await import('../enterprise/live-authority')
  await sendEnterpriseLiveInvalidations(scope, channel => sendLiveChannel(channel, events, config, send, now))
}

/** Transport only. Enterprise callers keep the authoritative capability row
 * locked through this complete bounded send, including retries. */
async function sendLiveChannel(channel: string, events: LiveInvalidation[], config: NonNullable<ReturnType<typeof liveGatewayConfig>>, send: typeof fetch, now: () => number) {
  if (config.mode === 'builtin') {
    try {
      const { builtinGateway } = await import('../builtin-gateway/runtime')
      await builtinGateway()?.hub.live(channel, events)
    } catch { console.warn('[live] builtin gateway invalidation unavailable') }
    return
  }
  const url = gatewayURL(config, `/v1/live/${channel}/push`)
  const revised = events.some(event => event.rev !== undefined)
  let body = revised && now() < plainUntil ? withoutRevisions(events) : events
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await send(url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3_000),
        headers: { authorization: `Bearer ${config.secret}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      await response.body?.cancel().catch(() => {})
      if (response.ok) return
      if (response.status === 400 && body.some(event => event.rev !== undefined)) {
        // The same keys without revisions: every client then simply reads.
        plainUntil = now() + PLAIN_AFTER_REFUSAL_MS
        body = withoutRevisions(events); attempt--; continue
      }
      if (response.status < 500 && response.status !== 429) break
    } catch { /* a retry carries the same invalidation keys only */ }
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)))
  }
  console.warn('[live] gateway invalidation unavailable')
}

/** An old Worker refuses the control. Never report that refusal as an ACK or
 * downgrade it to a plain metadata push. The durable source barrier remains. */
export async function revokeLiveChannel(channel: string, env = process.env, send = fetch): Promise<boolean> {
  const config = liveGatewayConfig(env)
  if (!config) return false
  if (gatewayConfig(env)?.mode === 'builtin') {
    const { builtinGateway } = await import('../builtin-gateway/runtime')
    const runtime = builtinGateway()
    if (!runtime) return false
    await runtime.hub.revokeLive(channel)
    return true
  }
  const response = await send(gatewayURL(config, `/v1/live/${channel}/push`), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3_000),
    headers: { authorization: `Bearer ${config.secret}`, 'content-type': 'application/json' }, body: JSON.stringify(LIVE_REVOKE),
  })
  if (response.status !== 200) { await response.body?.cancel().catch(() => {}); return false }
  const reply: unknown = await response.json()
  return !!reply && typeof reply === 'object' && Object.keys(reply).length === 1 && (reply as { revoked?: unknown }).revoked === true
}

/** Call only after the owning database transaction has committed. */
export function scheduleLive(work: () => Promise<void>) {
  // after() may invoke this after the request scope has ended. Scope is
  // retained for fresh reads; permissions are still resolved by the work.
  afterJob('after:live-notify', async () => {
    try {
      const { withoutWorkspaceClient } = await import('../workspace-db')
      await withoutWorkspaceClient(work)
    } catch (error) {
      // By name and code only (decision 2026-11-05-0330): a message can carry database content.
      console.warn('[live] committed invalidation failed', { name: (error as Error | undefined)?.name, code: (error as { code?: unknown } | undefined)?.code })
    }
  }, { orRun: true, retainContext: true })
}

export function notifyLive(scope: LiveScope, events: LiveInvalidation[]) {
  scheduleLive(() => sendLiveInvalidations(scope, events))
}
