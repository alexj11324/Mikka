import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { apiKeyAfterQuota, usableApiKeys, type UsableApiKey } from './model-api-keys'
import { apiKeyChatBaseUrl } from './model-api-key-providers'

type Query = Pick<Pool | PoolClient, 'query'>

/**
 * 订阅额度用完后，自动改用 API Key (orchestration.md § 2): the key and model
 * the next turn uses when the subscription it would use is out of quota, or
 * null when the person turned it off or has no key a bot chat can reach. Only
 * the person's own keys count, never a teammate's shared one: the key pays,
 * so it is theirs. Only a key serving the same model qualifies (decision 1700).
 */
export async function quotaFallbackKey(query: Query, ownerId: string, workspaceId: string, modelId: string): Promise<{ key: UsableApiKey; model: string } | null> {
  if (!(await apiKeyAfterQuota(query, ownerId))) return null
  const keys = (await usableApiKeys(query, ownerId, workspaceId)).filter(key => key.mine && apiKeyChatBaseUrl(key) && key.models.length)
  const key = keys.find(key => key.models.includes(modelId))
  return key ? { key, model: modelId } : null
}
