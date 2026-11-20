import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { apiKeyAfterQuota, botApiKeyChoice, usableApiKeys } from '@/lib/model-api-keys'
import { apiKeyChatBaseUrl, apiKeyHarnesses, type ApiKeyView } from '@/lib/model-api-key-providers'
import { isCatalogId, vendorOf } from '@/lib/model-catalog'
import { gatewayLiteLlm } from '@/lib/model-gateway/config'
import { subscriptionAvailability } from './subscription-quota'

type Query = Pick<Pool | PoolClient, 'query'>

/** The API key a run is frozen on: its id and the model asked of it. Never the key itself. */
export interface RunApiKey { keyId: string; model: string }

interface Binding { id: string; ownerId: string; connectionId: string; connectionRevision: number; modelId?: string }

/**
 * The keys a run may use, as `validateRunApiKey` checks them at claim: in a bot's
 * workspace its owner's own keys, then teammates' shared ones; with no bot
 * (the Coordinator), the owner's own keys only.
 */
type RunKey = Pick<ApiKeyView, 'id' | 'provider' | 'protocol' | 'responsesApi' | 'models' | 'baseUrl'>
async function runKeys(query: Query, ownerId: string, botWorkspaceId: string | null): Promise<RunKey[]> {
  if (botWorkspaceId) return usableApiKeys(query, ownerId, botWorkspaceId)
  return (await query.query<RunKey>('SELECT id,provider,protocol,"responsesApi",models,"baseUrl" FROM model_api_keys WHERE "ownerId"=$1 ORDER BY "createdAt",id', [ownerId])).rows
}

/**
 * The Agents a key can run through the Mikka model gateway: with LiteLLM
 * converting protocols (decision 2026-11-15-2000), any key whose provider
 * speaks Chat Completions serves both Claude Code and Codex.
 */
export function runKeyHarnesses(key: Pick<ApiKeyView, 'provider' | 'protocol' | 'responsesApi' | 'baseUrl'>, env: Record<string, string | undefined> = process.env): string[] {
  const native = apiKeyHarnesses(key)
  return gatewayLiteLlm(env) && apiKeyChatBaseUrl(key) ? Array.from(new Set([...native, 'claude_code', 'codex'])) : native
}

/** The presets that sell a catalogue vendor's models under their own ids. */
const VENDOR_PRESET: Record<string, ApiKeyView['provider']> = { anthropic: 'anthropic', openai: 'openai', deepseek: 'deepseek', moonshotai: 'kimi' }

/**
 * The person's key for a catalogue model (`vendor/model`): a preset key of that
 * vendor listing the model under its own id. "Same model, another source"
 * (decision 2026-11-15-1900): a key the person pays for comes before Mikka 额度.
 */
function keyForCatalogModel(keys: RunKey[], harness: string, model: string): RunApiKey | undefined {
  const vendor = vendorOf(model), preset = VENDOR_PRESET[vendor]
  if (!preset) return
  const native = model.slice(model.indexOf('/') + 1)
  const key = keys.find(item => item.provider === preset && item.models.includes(native) && runKeyHarnesses(item).includes(harness))
  return key ? { keyId: key.id, model: native } : undefined
}

/** The first compatible key serving the asked model; a default is chosen only with no model. */
function firstKey(keys: RunKey[], harness: string, model?: string): RunApiKey | undefined {
  for (const key of keys) {
    if (!runKeyHarnesses(key).includes(harness)) continue
    const chosen = model ? key.models.includes(model) ? model : undefined : key.models[0]
    if (chosen) return { keyId: key.id, model: chosen }
  }
}

/**
 * A model an API key lists for this Agent and the selected subscription (or,
 * without one, the person's connected subscriptions) does not offer: a key's model in 优先使用的模型. It runs on
 * the key; a subscription is never asked for a model its account does not offer.
 * An entry of 优先使用的模型 that names its key (`keyId`) runs on that key when
 * the run may use it and it serves the model, whatever other key lists the model too.
 */
async function keyOnlyModel(query: Query, ownerId: string, keys: RunKey[], harness: string, model: string, keyId?: string, subscription?: Binding | null): Promise<RunApiKey | undefined> {
  const serves = (item: RunKey) => runKeyHarnesses(item).includes(harness) && item.models.includes(model)
  if (keyId) {
    const named = keys.find(item => item.id === keyId)
    if (named && serves(named)) return { keyId: named.id, model }
  }
  const key = keys.find(serves)
  if (!key) return
  // nativeBinding already authorized the selected credential for this run. A
  // teammate's subscription is still owned by that teammate: checking only
  // the borrower's accounts would silently turn it into a paid Key run.
  const { rowCount } = await query.query(`SELECT 1 FROM byos_connections WHERE "ownerId"=$1 AND provider=$2 AND state='connected' AND paused=false
    AND ($4::uuid IS NULL OR (id=$4::uuid AND epoch=$5::bigint))
    AND "modelCatalog"->>'revision'=epoch::text AND "modelCatalog"->'models' ? $3 LIMIT 1`,
    [subscription?.ownerId ?? ownerId, harness === 'codex' ? 'codex' : 'claude', model, subscription?.connectionId ?? null, subscription?.connectionRevision ?? null])
  return rowCount ? undefined : { keyId: key.id, model }
}

/** Whether a rule's model is one only an API key serves, so its run takes no subscription (rule-dispatch). */
export async function ruleApiKey(query: Query, input: { ownerId: string; botWorkspaceId: string | null; harness: string; model: string }): Promise<RunApiKey | undefined> {
  if (input.harness !== 'codex' && input.harness !== 'claude_code') return
  return keyOnlyModel(query, input.ownerId, await runKeys(query, input.ownerId, input.botWorkspaceId), input.harness, input.model)
}

/** Connected, not paused, on the binding's revision: what a subscription run can be leased now. */
async function subscriptionState(query: Query, binding: Binding, harness: string, model: string): Promise<'usable' | 'exhausted' | 'unusable'> {
  const { rows: [row] } = await query.query<{ state: string; paused: boolean; epoch: string; quota: unknown }>(
    'SELECT state,paused,epoch,quota FROM byos_connections WHERE id=$1 AND "ownerId"=$2', [binding.connectionId, binding.ownerId])
  if (!row || row.state !== 'connected' || row.paused || Number(row.epoch) !== binding.connectionRevision) return 'unusable'
  // Unknown allowance stays with the subscription for the execution check;
  // only an applicable, fresh exhausted window authorizes a paid fallback.
  return subscriptionAvailability(row.quota, model, harness === 'codex' ? 'codex' : 'claude').status === 'exhausted' ? 'exhausted' : 'usable'
}

/**
 * A new run's credential (orchestration.md § 2), read at dispatch and frozen
 * with the run: the bot's saved API-key model; else the subscription found
 * for the run's Agent; else the person's usable API key for that Agent. A
 * thread's explicit model/key takes precedence over the Bot chat preference.
 * A subscription whose stored quota is used up gives way to a key when
 * 「订阅额度用完后，自动改用 API Key」 is on. With no key the subscription is
 * kept as found, so nothing changes for a person without one. On a device
 * the CLI's own login counts as a subscription: only the bot's saved key
 * choice runs on a key there. The key is
 * not opened here: the model gateway opens it for each authorized request.
 */
export async function runCredentialSource<S extends Binding>(query: Query, input: {
  ownerId: string; botId: string | null; harness: string; model?: string
  /** The key an entry of 优先使用的模型 names (decision 2026-11-02-1400); used only when the run may use it. */
  keyId?: string
  /** The bot's workspace (null with no bot), and where the bot's saved model choice lives. */
  botWorkspaceId: string | null; choiceWorkspaceId: string | null | (() => Promise<string | null>)
  subscription: S | null
  /** A device run: the device's own CLI login is a subscription too, so only the bot's saved key choice uses a key. */
  localLogin?: boolean
}): Promise<{ subscription: S | null; apiKey?: RunApiKey; credits?: { model: string } }> {
  const kept = { subscription: input.subscription }
  if (input.harness !== 'codex' && input.harness !== 'claude_code') return kept
  const keys = await runKeys(query, input.ownerId, input.botWorkspaceId)
  // A catalogue model with no subscription named runs on the person's key for
  // that same model, else on Mikka 额度 through the model gateway (decision 2026-11-15-2000).
  if (input.model && !input.subscription && isCatalogId(input.model) && !keys.some(key => key.models.includes(input.model!))) {
    const named = input.keyId ? keys.find(key => key.id === input.keyId) : undefined
    const keyed = named ? keyForCatalogModel([named], input.harness, input.model) : keyForCatalogModel(keys, input.harness, input.model)
    return keyed ? { subscription: null, apiKey: keyed } : { subscription: null, credits: { model: input.model } }
  }
  if (!keys.length) return kept
  // A thread's explicit model/key is independent of the Bot chat preference.
  const choiceWorkspaceId = !input.model && !input.keyId ? typeof input.choiceWorkspaceId === 'function' ? await input.choiceWorkspaceId() : input.choiceWorkspaceId : null
  const saved = choiceWorkspaceId ? await botApiKeyChoice(query, { ownerId: input.ownerId, workspaceId: choiceWorkspaceId }, input.botId) : undefined
  if (saved && saved.harnesses.includes(input.harness) && keys.some(key => key.id === saved.keyId && key.models.includes(saved.model))) return { subscription: null, apiKey: { keyId: saved.keyId, model: saved.model } }
  const keyed = input.model ? await keyOnlyModel(query, input.ownerId, keys, input.harness, input.model, input.keyId, input.subscription) : undefined
  if (keyed) return { subscription: null, apiKey: keyed }
  // The server cannot see whether the device's CLI is signed in, so a free local login is never turned into per-token billing.
  if (input.localLogin) return kept
  const model = input.model ?? input.subscription?.modelId
  const state = input.subscription ? await subscriptionState(query, input.subscription, input.harness, model ?? '') : 'unusable'
  if (state === 'usable') return kept
  if (state === 'exhausted' && !(await apiKeyAfterQuota(query, input.ownerId))) return kept
  const apiKey = firstKey(keys, input.harness, model)
  return apiKey ? { subscription: null, apiKey } : kept
}

/**
 * The key a run on a subscription goes on with once that subscription's quota
 * ran out mid-run (lib/run-quota.ts): a compatible key serving that same frozen
 * model. The Bot chat's preference has no authority over a thread's model.
 * Whether 「订阅额度用完后，自动改用 API Key」 is on is the caller's check.
 */
export async function quotaFallbackApiKey(query: Query, input: {
  ownerId: string; botId: string | null; harness: string; model?: string
  botWorkspaceId: string | null; choiceWorkspaceId: string | null
}): Promise<RunApiKey | undefined> {
  if (!input.model || (input.harness !== 'codex' && input.harness !== 'claude_code')) return undefined
  const keys = await runKeys(query, input.ownerId, input.botWorkspaceId)
  if (!keys.length) return undefined
  return firstKey(keys, input.harness, input.model)
}

