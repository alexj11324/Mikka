import 'server-only'
import type { Pool } from 'pg'
import type { OrderHarness } from './model-order-plan'

type Query = Pick<Pool, 'query'>
export interface MainThreadModel { harness: OrderHarness; model: string }

/**
 * The model a new task follows when nobody named one (decision 2026-11-15-1630):
 * the model of the chat that dispatches it, the Coordinator's or a Bot's.
 *
 * Only a model a thread can run counts: a subscription or API-key model that is
 * one of the person's task candidates. 「Mikka 默认」 only answers in chats, so it
 * has none, and the task falls back to 优先使用的模型 until it can run threads.
 */
export async function mainThreadModel(pool: Query, scope: { ownerId: string; workspaceId: string }, botId: string | null): Promise<MainThreadModel | null> {
  const [{ botModelPreference }, { HOSTED_CHOICE }, { orderCandidates }] = await Promise.all([
    import('./bot-model-choice'), import('./bot-model-menu-view'), import('./model-order'),
  ])
  const preference = await botModelPreference(pool, scope, botId)
  let match: (candidate: Awaited<ReturnType<typeof orderCandidates>>[number]) => boolean
  if (preference.key) {
    const { keyId, model } = preference.key
    match = candidate => candidate.source.kind === 'api_key' && candidate.source.keyId === keyId && candidate.model === model
  } else {
    if (!preference.selected || preference.selected === HOSTED_CHOICE) return null
    const { rows: [binding] } = await pool.query<{ connectionId: string; modelId: string }>(
      'SELECT "connectionId"::text AS "connectionId","modelId" FROM byos_bindings WHERE id=$1 AND "ownerId"=$2', [preference.selected, scope.ownerId])
    if (!binding) return null
    match = candidate => candidate.source.kind === 'subscription' && candidate.source.connectionId === binding.connectionId && candidate.model === binding.modelId
  }
  const candidate = (await orderCandidates(pool, scope)).find(match)
  return candidate ? { harness: candidate.harness, model: candidate.model } : null
}
