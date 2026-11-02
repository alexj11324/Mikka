/** Local-only DeepSeek setup. Provider keys stay in process memory. */
import type { Pool } from 'pg'

export const DEV_MODEL_PREFERENCE = [/v4\.1.*flash/i, /flash/i]
interface ModelKey { id: string; models: string[] }
export interface SeedDeps {
  owners(): Promise<{ ownerId: string; key?: ModelKey }[]>
  addKey(ownerId: string, apiKey: string): Promise<ModelKey>
  scopes(ownerId: string, keyId: string, model: string): Promise<{ workspaceId: string; botIds: (string | null)[] }[]>
  choose(scope: { ownerId: string; workspaceId: string }, botId: string | null, keyId: string, model: string): Promise<void>
}
export type SeedState = Map<string, { failures: number; retryAt: number }>
export function preferredModel(models: string[]): string | undefined {
  for (const pattern of DEV_MODEL_PREFERENCE) { const hit = models.find(model => pattern.test(model)); if (hit) return hit }
  return undefined
}

/** Failures are isolated and backed off; existing keys never refetch /models. */
export async function seedModelKeys(apiKey: string | undefined, deps: SeedDeps, log: (line: string) => void = () => {}, state: SeedState = new Map(), now = Date.now): Promise<number> {
  if (!apiKey) return 0
  let seeded = 0
  for (const { ownerId, key: existing } of await deps.owners()) {
    if ((state.get(ownerId)?.retryAt ?? 0) > now()) continue
    try {
      const key = existing ?? await deps.addKey(ownerId, apiKey)
      const model = preferredModel(key.models)
      if (!model) throw new Error('DS 4.1 Flash is not listed by the DeepSeek key')
      for (const scope of await deps.scopes(ownerId, key.id, model)) for (const botId of scope.botIds) await deps.choose({ ownerId, workspaceId: scope.workspaceId }, botId, key.id, model)
      state.delete(ownerId)
      if (!existing) { log(`seeded DeepSeek key for 1 account (model ${model})`); seeded++ }
    } catch {
      const failures = (state.get(ownerId)?.failures ?? 0) + 1
      const delay = Math.min(300_000, 30_000 * 2 ** Math.min(failures - 1, 4))
      state.set(ownerId, { failures, retryAt: now() + delay })
      // Provider exceptions can contain the key or request headers. Log no error body.
      log(`DeepSeek setup failed for 1 account; retry in ${delay / 1000}s`)
    }
  }
  return seeded
}

export async function productSeedDeps(pool: Pool): Promise<SeedDeps> {
  const { addApiKey, setBotApiKeyChoice } = await import('@/lib/model-api-keys')
  return {
    owners: async () => (await pool.query<{ ownerId: string; keyId: string | null; models: string[] | null }>(
      `SELECT u.id AS "ownerId", k.id AS "keyId", k.models FROM "user" u
       LEFT JOIN model_api_keys k ON k."ownerId" = u.id AND k.provider = 'deepseek'`)).rows.map(row => ({ ownerId: row.ownerId, ...(row.keyId ? { key: { id: row.keyId, models: row.models ?? [] } } : {}) })),
    addKey: async (ownerId, apiKey) => addApiKey(pool, ownerId, { provider: 'deepseek', apiKey }),
    scopes: async (ownerId, keyId, model) => (await pool.query<{ workspaceId: string; botIds: (string | null)[] }>(
      `SELECT candidates."workspaceId", array_agg(candidates."botId") AS "botIds" FROM (
         SELECT m."workspaceId", b.id AS "botId" FROM mikka_workspace_members m
         JOIN bots b ON b."workspaceId" = m."workspaceId" AND b."ownerId" = $1 WHERE m."userId" = $1
         UNION ALL SELECT m."workspaceId", NULL::uuid FROM mikka_workspace_members m WHERE m."userId" = $1
       ) candidates LEFT JOIN bot_model_choices c ON c."ownerId" = $1 AND c."workspaceId" = candidates."workspaceId"
         AND c."botKey" = COALESCE(candidates."botId"::text, 'coordinator')
       WHERE c."apiKeyId" IS DISTINCT FROM $2::uuid OR c."apiKeyModel" IS DISTINCT FROM $3
       GROUP BY candidates."workspaceId"`, [ownerId, keyId, model])).rows,
    choose: async (scope, botId, keyId, model) => { await setBotApiKeyChoice(pool, scope, botId, keyId, model) },
  }
}
