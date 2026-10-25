import type { WakeDelivery } from './inbox-receipts'
/** Isolated acceptance transport, never a production Workflow or model provider.
 * A bad test configuration fails closed instead of falling back to paid start(). */
export function controlledWakeConfiguration() {
  const origin = process.env.MIKKA_WAKE_CONTROLLED_ORIGIN
  if (!origin) return null
  const url = new URL(origin),
    database = new URL(process.env.MIKKA_DATABASE_URL ?? 'http://invalid')
  if (
    process.env.CI !== 'true' ||
    process.env.VERCEL ||
    process.env.DECISION_GATEWAY_API_KEY ||
    process.env.AI_GATEWAY_API_KEY ||
    process.env.OPENCODE_API_KEY ||
    process.env.OPENAI_API_KEY ||
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    database.hostname !== '127.0.0.1' ||
    !database.pathname.endsWith('_176') ||
    !process.env.MIKKA_WAKE_CONTROLLED_TOKEN
  )
    throw new Error('controlledWakeUnsafeConfiguration')
  return { origin: url.origin, token: process.env.MIKKA_WAKE_CONTROLLED_TOKEN }
}
export async function startControlledWake(owner: string, delivery: WakeDelivery) {
  const config = controlledWakeConfiguration()
  if (!config) throw new Error('controlledWakeUnconfigured')
  const response = await fetch(new URL('/start', config.origin), {
    method: 'POST',
    headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ owner, delivery }),
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) throw new Error('controlledWakeTransportUnavailable')
  const body = (await response.json()) as { runId?: string }
  return { runId: body.runId }
}
