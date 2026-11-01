import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { quotaSnapshotSchema } from '@mikka/protocol'
import { apiKeyAfterQuota, botApiKeyChoice, usableApiKeys } from '@/lib/model-api-keys'
import { apiKeyHarness, type ApiKeyView } from '@/lib/model-api-key-providers'

type Query = Pick<Pool | PoolClient, 'query'>

/** The API key a run is frozen on: its id and the model asked of it. Never the key itself. */
export interface RunApiKey { keyId: string; model: string }

interface Binding { id: string; ownerId: string; connectionId: string; connectionRevision: number }

/**
 * The keys a run may use, as `apiKeyForRun` checks them at claim: in a bot's
 * workspace its owner's own keys, then teammates' shared ones; with no bot
 * (the Coordinator), the owner's own keys only.
 */
async function runKeys(query: Query, ownerId: string, botWorkspaceId: string | null): Promise<Pick<ApiKeyView, 'id' | 'protocol' | 'models'>[]> {
  if (botWorkspaceId) return usableApiKeys(query, ownerId, botWorkspaceId)
  return (await query.query<Pick<ApiKeyView, 'id' | 'protocol' | 'models'>>('SELECT id,protocol,models FROM model_api_keys WHERE "ownerId"=$1 ORDER BY "createdAt",id', [ownerId])).rows
}

/** The first key whose Agent is the run's: the asked model when it serves it, else its first listed model. */
function firstKey(keys: Pick<ApiKeyView, 'id' | 'protocol' | 'models'>[], harness: string, model?: string): RunApiKey | undefined {
  for (const key of keys) {
    if (apiKeyHarness(key.protocol) !== harness) continue
    const chosen = model && (!key.models.length || key.models.includes(model)) ? model : key.models[0]
    if (chosen) return { keyId: key.id, model: chosen }
  }
}

/** Connected, not paused, on the binding's revision: what a subscription run can be leased now. */
async function subscriptionState(query: Query, binding: Binding): Promise<'usable' | 'exhausted' | 'unusable'> {
  const { rows: [row] } = await query.query<{ state: string; paused: boolean; epoch: string; quota: unknown }>(
    'SELECT state,paused,epoch,quota FROM byos_connections WHERE id=$1 AND "ownerId"=$2', [binding.connectionId, binding.ownerId])
  if (!row || row.state !== 'connected' || row.paused || Number(row.epoch) !== binding.connectionRevision) return 'unusable'
  // The stored quota (byos_connections.quota) is what dispatch can read: a window used up and not yet reset.
  const quota = quotaSnapshotSchema.safeParse(row.quota).data
  const now = Date.now()
  return quota?.status === 'ok' && quota.windows.some(window => window.used >= 1 && (!window.resetsAt || Date.parse(window.resetsAt) > now)) ? 'exhausted' : 'usable'
}

/**
 * A new run's credential (orchestration.md § 2), read at dispatch and frozen
 * with the run: the bot's saved API-key model; else the subscription found
 * for the run's Agent; else the person's usable API key for that Agent.
 * A subscription whose stored quota is used up gives way to a key when
 * 「订阅额度用完后，自动改用 API Key」 is on. With no key the subscription is
 * kept as found, so nothing changes for a person without one. The key is
 * not opened here: only `apiKeyForRun` does, at claim.
 */
export async function runCredentialSource<S extends Binding>(query: Query, input: {
  ownerId: string; botId: string | null; harness: string; model?: string
  /** The bot's workspace (null with no bot), and where the bot's saved model choice lives. */
  botWorkspaceId: string | null; choiceWorkspaceId: string | null | (() => Promise<string | null>)
  subscription: S | null
}): Promise<{ subscription: S | null; apiKey?: RunApiKey }> {
  const kept = { subscription: input.subscription }
  if (input.harness !== 'codex' && input.harness !== 'claude_code') return kept
  const keys = await runKeys(query, input.ownerId, input.botWorkspaceId)
  if (!keys.length) return kept
  const choiceWorkspaceId = typeof input.choiceWorkspaceId === 'function' ? await input.choiceWorkspaceId() : input.choiceWorkspaceId
  const saved = choiceWorkspaceId ? await botApiKeyChoice(query, { ownerId: input.ownerId, workspaceId: choiceWorkspaceId }, input.botId) : undefined
  if (saved && saved.harness === input.harness && keys.some(key => key.id === saved.keyId)) return { subscription: null, apiKey: { keyId: saved.keyId, model: saved.model } }
  const state = input.subscription ? await subscriptionState(query, input.subscription) : 'unusable'
  if (state === 'usable') return kept
  if (state === 'exhausted' && !(await apiKeyAfterQuota(query, input.ownerId))) return kept
  const apiKey = firstKey(keys, input.harness, input.model)
  return apiKey ? { subscription: null, apiKey } : kept
}

/** For a thread's model with no rule (rule-dispatch `threadModel`): the person's first usable key, on its own Agent. */
export async function firstRunApiKey(query: Query, ownerId: string, botWorkspaceId: string | null): Promise<(RunApiKey & { harness: 'claude_code' | 'codex' }) | undefined> {
  for (const key of await runKeys(query, ownerId, botWorkspaceId)) {
    if (key.models[0]) return { keyId: key.id, model: key.models[0], harness: apiKeyHarness(key.protocol) }
  }
}
