/**
 * dev:local only: every local account gets the DeepSeek preset key through the
 * product's own path (lib/model-api-keys.ts addApiKey: model-list check, sealed
 * storage), and its Coordinator and bots run on the preferred model. Accounts
 * that already have a DeepSeek key are left alone, so this repeats safely.
 */
import type { Pool } from 'pg'

export const DEV_MODEL_PREFERENCE = [/v4\.1.*flash/i, /flash/i, /chat/i]

export interface SeedDeps {
  ownersWithoutKey(): Promise<string[]>
  addKey(ownerId: string, apiKey: string): Promise<{ id: string; models: string[] }>
  scopes(ownerId: string): Promise<{ workspaceId: string; botIds: (string | null)[] }[]>
  choose(scope: { ownerId: string; workspaceId: string }, botId: string | null, keyId: string, model: string): Promise<void>
}

export function preferredModel(models: string[]): string | undefined {
  for (const pattern of DEV_MODEL_PREFERENCE) { const hit = models.find(model => pattern.test(model)); if (hit) return hit }
  return models[0]
}

/** Returns how many accounts were seeded; never logs the key. */
export async function seedModelKeys(apiKey: string | undefined, deps: SeedDeps, log: (line: string) => void = () => {}): Promise<number> {
  if (!apiKey) return 0
  let seeded = 0
  for (const ownerId of await deps.ownersWithoutKey()) {
    const key = await deps.addKey(ownerId, apiKey)
    const model = preferredModel(key.models)
    if (model) for (const scope of await deps.scopes(ownerId)) for (const botId of scope.botIds) await deps.choose({ ownerId, workspaceId: scope.workspaceId }, botId, key.id, model)
    log(`seeded DeepSeek key for 1 account (model ${model ?? 'none listed'})`)
    seeded++
  }
  return seeded
}

/** The product's own storage, for the dev:local loop. */
export async function productSeedDeps(pool: Pool): Promise<SeedDeps> {
  const { addApiKey, setBotApiKeyChoice } = await import('@/lib/model-api-keys')
  return {
    ownersWithoutKey: async () => (await pool.query<{ id: string }>(
      `SELECT u.id FROM "user" u WHERE NOT EXISTS (SELECT 1 FROM model_api_keys k WHERE k."ownerId" = u.id AND k.provider = 'deepseek')`)).rows.map(row => row.id),
    addKey: async (ownerId, apiKey) => addApiKey(pool, ownerId, { provider: 'deepseek', apiKey }),
    scopes: async ownerId => (await pool.query<{ workspaceId: string; botIds: (string | null)[] }>(
      `SELECT m."workspaceId", array_remove(array_agg(DISTINCT b.id), NULL) || ARRAY[NULL]::uuid[] AS "botIds"
       FROM mikka_workspace_members m LEFT JOIN bots b ON b."workspaceId" = m."workspaceId" AND b."ownerId" = $1
       WHERE m."userId" = $1 GROUP BY m."workspaceId"`, [ownerId])).rows,
    choose: async (scope, botId, keyId, model) => { await setBotApiKeyChoice(pool, scope, botId, keyId, model) },
  }
}
