import 'server-only'
import { COORDINATOR_MODEL } from './coordinator/model'
import { selfHostedDefaultModelConfig } from './default-model-config'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { WorkspaceError } from './workspace-error'
import { reconcileSubscriptionModels, type ModelSettings } from './enabled-models-policy'

type Scope = { ownerId: string; workspaceId: string }
export type ModelSourceKind = 'subscription' | 'api_key' | 'hosted'
export interface EnabledModelsSource {
  id: string; kind: ModelSourceKind
  models: { id: string; enabled: boolean; fresh: boolean }[]
  enabledCount: number; total: number; freshCount: number; autoEnable?: boolean
  refreshedAt: string | null; refreshError: 'invalid' | 'unavailable' | null
}
type SourceRow = { id: string; kind: ModelSourceKind; ids: string[]; settings: ModelSettings | null; refreshedAt: string | null; refreshError: EnabledModelsSource['refreshError'] }
const project = (row: SourceRow): EnabledModelsSource => {
  const models = row.ids.map(id => ({ id, enabled: row.settings?.models[id]?.enabled ?? true, fresh: row.settings?.models[id]?.fresh ?? false }))
  return { id: row.id, kind: row.kind, models, total: models.length, enabledCount: models.filter(item => item.enabled).length,
    freshCount: models.filter(item => item.fresh).length, ...(row.kind === 'subscription' ? { autoEnable: row.settings?.autoEnable ?? true } : {}),
    refreshedAt: row.refreshedAt, refreshError: row.refreshError }
}
async function sources(query: Pick<Pool | PoolClient, 'query'>, scope: Scope): Promise<SourceRow[]> {
  const subscriptions = await query.query<SourceRow>(`SELECT id::text,'subscription' AS kind,
    COALESCE("modelCatalog"->'models','[]'::jsonb) AS ids,"modelSettings" AS settings,
    "updatedAt"::text AS "refreshedAt",NULL AS "refreshError" FROM byos_connections
    WHERE "ownerId"=$1 AND "removedAt" IS NULL ORDER BY "createdAt",id`, [scope.ownerId])
  const keys = await query.query<SourceRow>(`SELECT id::text,'api_key' AS kind,models AS ids,"modelSettings" AS settings,
    "updatedAt"::text AS "refreshedAt","modelsError" AS "refreshError" FROM model_api_keys WHERE "ownerId"=$1 ORDER BY "createdAt",id`, [scope.ownerId])
  const hosted = await query.query<{ enabled: boolean }>('SELECT "hostedModelEnabled" AS enabled FROM "user" WHERE id=$1', [scope.ownerId])
  const hostedModelId = selfHostedDefaultModelConfig()?.modelId ?? COORDINATOR_MODEL
  return [...subscriptions.rows, ...keys.rows, { id: 'hosted', kind: 'hosted', ids: [hostedModelId],
    settings: { autoEnable: false, models: { [hostedModelId]: { enabled: hosted.rows[0]?.enabled ?? true, fresh: false, manual: true } } },
    refreshedAt: null, refreshError: null }]
}
export async function readEnabledModels(query: Pick<Pool | PoolClient, 'query'>, scope: Scope) {
  return { sources: (await sources(query, scope)).map(project) }
}
export type ModelSettingsChange = { kind: 'model'; modelId: string; enabled: boolean } | { kind: 'all'; enabled: boolean }
  | { kind: 'auto'; enabled: boolean } | { kind: 'seen' }
const changeInput = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('model'), modelId: z.string().min(1).max(128), enabled: z.boolean() }),
  z.strictObject({ kind: z.literal('all'), enabled: z.boolean() }), z.strictObject({ kind: z.literal('auto'), enabled: z.boolean() }),
  z.strictObject({ kind: z.literal('seen') }),
])
/** Only the credential owner can change its catalogue, including when shared.
 * Every mutation/refresh serializes on the same credential row. Runs already
 * frozen on a credential are neither stopped nor rewritten. */
export async function changeEnabledModels(pool: Pool, scope: Scope, sourceId: string, input: ModelSettingsChange) {
  const change = changeInput.parse(input)
  if (sourceId !== 'hosted') z.uuid().parse(sourceId)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    let kind: ModelSourceKind = 'hosted'
    if (sourceId === 'hosted') await client.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [scope.ownerId])
    else {
      const subscription = await client.query('SELECT id FROM byos_connections WHERE id=$1 AND "ownerId"=$2 AND "removedAt" IS NULL FOR UPDATE', [sourceId, scope.ownerId])
      kind = subscription.rowCount ? 'subscription' : 'api_key'
      if (!subscription.rowCount) {
        const key = await client.query('SELECT id FROM model_api_keys WHERE id=$1 AND "ownerId"=$2 FOR UPDATE', [sourceId, scope.ownerId])
        if (!key.rowCount) throw new WorkspaceError('executionModelUnknown')
      }
    }
    const row = (await sources(client, scope)).find(row => row.id === sourceId)
    if (!row) throw new WorkspaceError('executionModelUnknown')
    if (change.kind === 'auto' && kind !== 'subscription') throw new WorkspaceError('validationGeneric')
    if (change.kind === 'model' && !row.ids.includes(change.modelId)) throw new WorkspaceError('executionModelUnknown')
    let settings: ModelSettings = row.settings ?? { autoEnable: true, models: Object.fromEntries(row.ids.map(id => [id, { enabled: true, fresh: false, manual: true }])) }
    if (change.kind === 'auto') {
      settings = reconcileSubscriptionModels(row.ids, { ...settings, autoEnable: change.enabled })
    } else for (const id of row.ids) {
      if (change.kind === 'model' && change.modelId !== id) continue
      const prior = settings.models[id] ?? { enabled: true, fresh: false, manual: false }
      settings.models[id] = change.kind === 'seen' ? { ...prior, fresh: false } : { enabled: change.enabled, fresh: false, manual: true }
    }
    if (kind === 'hosted') await client.query('UPDATE "user" SET "hostedModelEnabled"=$2 WHERE id=$1', [scope.ownerId, settings.models[row.ids[0]].enabled])
    else {
      // The table name is selected solely from this closed, server-derived set.
      const table = kind === 'subscription' ? 'byos_connections' : 'model_api_keys'
      await client.query(`UPDATE ${table} SET "modelSettings"=$3::jsonb WHERE id=$1 AND "ownerId"=$2`, [sourceId, scope.ownerId, JSON.stringify(settings)])
      const disabled = Object.entries(settings.models).filter(([, item]) => !item.enabled).map(([id]) => id)
      await client.query('DELETE FROM model_order_entries WHERE "sourceKind"=$1 AND "sourceId"=$2::uuid AND model=ANY($3::text[])', [kind, sourceId, disabled])
    }
    await client.query('COMMIT')
    return project({ ...row, settings })
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

export async function hostedModelEnabled(query: Pick<Pool | PoolClient, 'query'>, ownerId: string) {
  const { rows: [row] } = await query.query<{ enabled: boolean }>(`SELECT COALESCE((to_jsonb(u)->>'hostedModelEnabled')::boolean,true) AS enabled FROM "user" u WHERE id=$1`, [ownerId])
  return row?.enabled ?? true
}
