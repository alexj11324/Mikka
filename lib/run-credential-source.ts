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

/**
 * A model an API key lists for this Agent and none of the person's connected subscriptions of that
 * Agent's provider lists in its catalogue: a key's model in 允许使用的模型. It runs on
 * the key; a subscription is never asked for a model its account does not offer.
 */
async function keyOnlyModel(query: Query, ownerId: string, keys: Pick<ApiKeyView, 'id' | 'protocol' | 'models'>[], harness: string, model: string): Promise<RunApiKey | undefined> {
  const key = keys.find(item => apiKeyHarness(item.protocol) === harness && item.models.includes(model))
  if (!key) return
  const { rowCount } = await query.query(`SELECT 1 FROM byos_connections WHERE "ownerId"=$1 AND provider=$2 AND state='connected' AND "modelCatalog"->'models' ? $3 LIMIT 1`,
    [ownerId, harness === 'codex' ? 'codex' : 'claude', model])
  return rowCount ? undefined : { keyId: key.id, model }
}

/** Whether a rule's model is one only an API key serves, so its run takes no subscription (rule-dispatch). */
export async function ruleApiKey(query: Query, input: { ownerId: string; botWorkspaceId: string | null; harness: string; model: string }): Promise<RunApiKey | undefined> {
  if (input.harness !== 'codex' && input.harness !== 'claude_code') return
  return keyOnlyModel(query, input.ownerId, await runKeys(query, input.ownerId, input.botWorkspaceId), input.harness, input.model)
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
 * kept as found, so nothing changes for a person without one. On a device
 * the CLI's own login counts as a subscription: only the bot's saved key
 * choice runs on a key there. The key is
 * not opened here: only `apiKeyForRun` does, at claim.
 */
export async function runCredentialSource<S extends Binding>(query: Query, input: {
  ownerId: string; botId: string | null; harness: string; model?: string
  /** The bot's workspace (null with no bot), and where the bot's saved model choice lives. */
  botWorkspaceId: string | null; choiceWorkspaceId: string | null | (() => Promise<string | null>)
  subscription: S | null
  /** A device run: the device's own CLI login is a subscription too, so only the bot's saved key choice uses a key. */
  localLogin?: boolean
}): Promise<{ subscription: S | null; apiKey?: RunApiKey }> {
  const kept = { subscription: input.subscription }
  if (input.harness !== 'codex' && input.harness !== 'claude_code') return kept
  const keys = await runKeys(query, input.ownerId, input.botWorkspaceId)
  if (!keys.length) return kept
  const choiceWorkspaceId = typeof input.choiceWorkspaceId === 'function' ? await input.choiceWorkspaceId() : input.choiceWorkspaceId
  const saved = choiceWorkspaceId ? await botApiKeyChoice(query, { ownerId: input.ownerId, workspaceId: choiceWorkspaceId }, input.botId) : undefined
  if (saved && saved.harness === input.harness && keys.some(key => key.id === saved.keyId)) return { subscription: null, apiKey: { keyId: saved.keyId, model: saved.model } }
  const keyed = input.model ? await keyOnlyModel(query, input.ownerId, keys, input.harness, input.model) : undefined
  if (keyed) return { subscription: null, apiKey: keyed }
  // The server cannot see whether the device's CLI is signed in, so a free local login is never turned into per-token billing.
  if (input.localLogin) return kept
  const state = input.subscription ? await subscriptionState(query, input.subscription) : 'unusable'
  if (state === 'usable') return kept
  if (state === 'exhausted' && !(await apiKeyAfterQuota(query, input.ownerId))) return kept
  const apiKey = firstKey(keys, input.harness, input.model)
  return apiKey ? { subscription: null, apiKey } : kept
}

/**
 * The key a run on a subscription goes on with once that subscription's quota
 * ran out mid-run (lib/run-quota.ts): the bot's saved API-key model when it is
 * the run's Agent's, else the first usable key for that Agent. Nothing when the
 * person has none. Whether 「订阅额度用完后，自动改用 API Key」 is on is the caller's check.
 */
export async function quotaFallbackApiKey(query: Query, input: {
  ownerId: string; botId: string | null; harness: string; model?: string
  botWorkspaceId: string | null; choiceWorkspaceId: string | null
}): Promise<RunApiKey | undefined> {
  if (input.harness !== 'codex' && input.harness !== 'claude_code') return undefined
  const keys = await runKeys(query, input.ownerId, input.botWorkspaceId)
  if (!keys.length) return undefined
  const saved = input.choiceWorkspaceId ? await botApiKeyChoice(query, { ownerId: input.ownerId, workspaceId: input.choiceWorkspaceId }, input.botId) : undefined
  if (saved && saved.harness === input.harness && keys.some(key => key.id === saved.keyId)) return { keyId: saved.keyId, model: saved.model }
  return firstKey(keys, input.harness, input.model)
}

