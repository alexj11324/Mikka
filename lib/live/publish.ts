import type { PoolClient } from 'pg'
import type { LiveInvalidation } from './events'
import { bumpLiveRevisions, withLiveRevisions, type LiveRevisions } from './revisions'
import { liveGatewayConfig, type LiveScope } from './scope'

/** Raise each distinct key's revision once for the whole fan-out, then send.
 * A failed raise sends plain keys: a key without a revision always reads. */
export async function sendLiveTargets(database: Pick<PoolClient, 'query'>, targets: readonly { scope: LiveScope; events: LiveInvalidation[] }[], env = process.env) {
  if (!targets.length || !liveGatewayConfig(env)) return
  const { sendLiveInvalidations } = await import('./notify')
  let revisions: LiveRevisions = {}
  try { revisions = await bumpLiveRevisions(database, targets.flatMap(target => target.events)) }
  catch (error) { console.warn('[live] revision unavailable', { name: (error as Error | undefined)?.name, code: (error as { code?: string } | undefined)?.code }) }
  await Promise.all(targets.map(target => sendLiveInvalidations(target.scope, withLiveRevisions(target.events, revisions))))
}
