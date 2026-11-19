import 'server-only'
import type { Pool } from 'pg'
import type { OrderHarness } from './model-order-plan'

type Query = Pick<Pool, 'query'>
export interface MainThreadModel { harness: OrderHarness; model: string }

/**
 * The runnable model of a chat, the Coordinator's or a Bot's. Dispatch no longer
 * uses it as a default: every dispatch names its Agent (decision 2026-11-17-1800,
 * superseding 2026-11-15-1630's 「跟随主线程」).
 *
 * Only a model a thread can run counts: a subscription or API-key model that is
 * one of the person's task candidates, or a chat's Mikka 额度 model
 * (`credits:<vendor/model>`), which a thread runs through the Mikka model gateway
 * on the CLI `harnessFor` names (decision 2026-11-15-2000). A chat with nothing
 * chosen has none.
 */
export async function mainThreadModel(pool: Query, scope: { ownerId: string; workspaceId: string }, botId: string | null): Promise<MainThreadModel | null> {
  const [{ botModelPreference }, { parseCreditsOption }, { orderCandidates }] = await Promise.all([
    import('./bot-model-choice'), import('./bot-model-menu-view'), import('./model-order'),
  ])
  const preference = await botModelPreference(pool, scope, botId)
  let match: (candidate: Awaited<ReturnType<typeof orderCandidates>>[number]) => boolean
  if (preference.key) {
    const { keyId, model } = preference.key
    match = candidate => candidate.source.kind === 'api_key' && candidate.source.keyId === keyId && candidate.model === model
  } else {
    if (!preference.selected) return null
    const credits = parseCreditsOption(preference.selected)
    if (credits) {
      const { harnessFor } = await import('./model-catalog')
      return { harness: harnessFor(credits), model: credits }
    }
    // The person's own choice row names their own binding: a subscription
    // serves its owner only (decision 2026-11-17).
    const { rows: [binding] } = await pool.query<{ connectionId: string; modelId: string }>(
      'SELECT "connectionId"::text AS "connectionId","modelId" FROM byos_bindings WHERE id=$1 AND "ownerId"=$2',
      [preference.selected, scope.ownerId])
    if (!binding) return null
    match = candidate => candidate.source.kind === 'subscription' && candidate.source.connectionId === binding.connectionId && candidate.model === binding.modelId
  }
  const candidate = (await orderCandidates(pool, scope)).find(match)
  return candidate ? { harness: candidate.harness, model: candidate.model } : null
}
