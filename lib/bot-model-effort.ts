import 'server-only'
import type { Pool } from 'pg'
import { MODEL_ROUTING_EFFORTS, type ModelRoutingEffort } from './model-routing'

/** The Bot's saved reasoning effort (bot_model_choices.effort, beside its model choice); null is the model's default. */
export async function botModelEffort(query: Pick<Pool, 'query'>, scope: { ownerId: string; workspaceId: string }, botId: string | null): Promise<ModelRoutingEffort | null> {
  const { rows: [row] } = await query.query<{ effort: string | null }>(
    'SELECT effort FROM bot_model_choices WHERE "ownerId"=$1 AND "workspaceId"=$2 AND "botKey"=$3',
    [scope.ownerId, scope.workspaceId, botId ?? 'coordinator'])
  return MODEL_ROUTING_EFFORTS.find(item => item === row?.effort) ?? null
}
