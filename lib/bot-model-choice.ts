import 'server-only'
import { hostedModelEnabled } from './enabled-models'
import { ActionFailureError } from './action-error'
import type { Pool } from 'pg'
import type { ExecutionSettings, ExecutionSettingsScope } from './execution-settings'
import type { ModelCandidateSnapshot } from './model-order'
import { creditsOptionId, parseCreditsOption, type BotModelQuota } from './bot-model-menu-view'
import { apiKeyChatBaseUrl } from './model-api-key-providers'
import { usableApiKeys, type UsableApiKey } from './model-api-keys'
import { subscriptionAvailability } from './subscription-quota'
import { isCloudEdition } from './edition'

type Settings = Pick<ExecutionSettings, 'chatModels' | 'chatBinding'>
export interface BotSubscriptionChoice {
  bindingId: string
  connectionId: string
  ownerId: string
  modelId: string
  provider: string
  accountLabel?: string | null
  plan?: string | null
  quota?: unknown
}
type FallbackReason = 'preference' | 'points' | 'quota'
interface ChoiceState { chosen: boolean; fallback?: FallbackReason }
export type BotModelChoice = ChoiceState & (
  /** Mikka 额度, a catalogue model (`vendor/model`). */
  | { kind: 'hosted'; model: string }
  /** Nothing chosen and no subscription or key fills in (decision 2026-11-15-1900). */
  | { kind: 'none' }
  | { kind: 'subscription'; binding: BotSubscriptionChoice; quota?: BotModelQuota }
  | { kind: 'apiKey'; key: UsableApiKey; model: string; quota?: BotModelQuota }
)

export function apiKeyServesBotModel(key: UsableApiKey, model: string) {
  return Boolean(apiKeyChatBaseUrl(key) && key.models.includes(model))
}

/** Reads the saved preference without creating a default or cloning a binding. */
export async function botModelPreference(pool: Pick<Pool, 'query'>, scope: ExecutionSettingsScope, botId: string | null) {
  const { rows: [row] } = await pool.query<{ bindingId: string | null; apiKeyId: string | null; apiKeyModel: string | null; creditsModel: string | null }>(
    'SELECT "bindingId","apiKeyId","apiKeyModel","creditsModel" FROM bot_model_choices WHERE "ownerId"=$1 AND "workspaceId"=$2 AND "botKey"=$3',
    [scope.ownerId, scope.workspaceId, botId ?? 'coordinator'],
  )
  if (row?.apiKeyId != null && row.apiKeyModel != null) return { key: { keyId: row.apiKeyId, model: row.apiKeyModel } }
  if (row?.creditsModel) return { selected: creditsOptionId(row.creditsModel) }
  // A row with none of the three was 「Mikka 默认」, now gone: it reads as no choice.
  return { selected: row?.bindingId ?? undefined }
}

/**
 * The next turn's read-only choice. The menu and reservation use this same
 * order; only reservation clones a binding and freezes its authorization.
 * Reading the menu never replaces the person's saved preference.
 */
export async function resolveBotModelChoice(
  pool: Pick<Pool, 'query'>,
  settings: Settings,
  scope: ExecutionSettingsScope,
  botId: string | null,
  preference: { selected?: string; key?: { keyId: string; model: string } },
  cached: { rows?: BotSubscriptionChoice[]; keys?: UsableApiKey[]; now?: number; fallback?: ModelCandidateSnapshot } = {},
): Promise<BotModelChoice> {
  const now = cached.now ?? Date.now()
  const keys = cached.keys ?? await usableApiKeys(pool, scope.ownerId, scope.workspaceId)
  const key = preference.key && keys.find(item => item.id === preference.key!.keyId && apiKeyServesBotModel(item, preference.key!.model))
  if (key && preference.key) return { kind: 'apiKey', key, model: preference.key.model, chosen: true }
  const fallback = preference.key ? 'preference' as const : undefined

  // Only hosted choices consume this policy; both consumers share one read per invocation.
  let hostedPolicy: Promise<boolean> | undefined
  const hostedAllowed = () => hostedPolicy ??= hostedModelEnabled(pool, scope.ownerId)
  const hosted = async (state: ChoiceState, model: string): Promise<BotModelChoice> => {
    if (!await hostedAllowed()) {
      const next = await (await import('./points-fallback')).pointsFallback(pool as Pool, scope, cached.fallback)
      if (next?.kind === 'api_key') {
        const key = keys.find(item => item.id === next.keyId && apiKeyServesBotModel(item, next.model))
        if (key) return { kind: 'apiKey', key, model: next.model, chosen: false, fallback: 'preference' }
      }
      if (next?.kind === 'subscription') {
        const binding = await settings.chatBinding(scope, next.bindingId)
        if (binding) return { kind: 'subscription', binding, chosen: false, fallback: 'preference' }
      }
      throw new ActionFailureError('executionModelUnknown')
    }
    // Community defaults either spend their explicitly bound cloud workspace
    // or their own provider. Local hosted balances never redirect that choice.
    if (!isCloudEdition()) return { kind: 'hosted', model, ...state }
    const { hostedPointsRefusal, pointsFallback } = await import('./points-fallback')
    const next = await hostedPointsRefusal(scope.workspaceId) ? await pointsFallback(pool as Pool, scope, cached.fallback) : null
    if (next?.kind === 'api_key') {
      const key = keys.find(item => item.id === next.keyId && apiKeyServesBotModel(item, next.model))
      if (key) return { kind: 'apiKey', key, model: next.model, chosen: false, fallback: 'points' }
    }
    if (next?.kind === 'subscription') {
      const binding = await settings.chatBinding(scope, next.bindingId)
      if (binding) return { kind: 'subscription', binding, chosen: false, fallback: 'points' }
    }
    return { kind: 'hosted', model, ...state }
  }
  const credits = !preference.key && preference.selected ? parseCreditsOption(preference.selected) : null
  if (credits && await hostedAllowed()) return hosted({ chosen: true }, credits)

  const selected = preference.selected && !preference.key && !credits ? await settings.chatBinding(scope, preference.selected) : undefined
  // A valid saved binding is already route-checked; only fallback needs the full catalogue.
  const rows = selected ? [] : cached.rows ?? await settings.chatModels(scope)
  const binding = selected ?? rows.find(row => row.provider === 'claude') ?? rows[0]
  const state: ChoiceState = {
    chosen: Boolean(selected),
    ...(!selected && (preference.selected || fallback) ? { fallback: 'preference' as const } : {}),
  }
  const withQuota = async (binding: BotSubscriptionChoice): Promise<BotModelChoice> => {
    const availability = subscriptionAvailability(binding.quota, binding.modelId, binding.provider === 'codex' ? 'codex' : 'claude', now)
    if (availability.status !== 'exhausted') return { kind: 'subscription', binding, ...state }
    const quota: BotModelQuota = { subscription: binding.provider, plan: binding.plan ?? null,
      resetsAt: availability.resetsAt, fallback: null }
    const { quotaFallbackKey } = await import('./quota-fallback')
    const next = await quotaFallbackKey(pool, scope.ownerId, scope.workspaceId, binding.modelId)
    if (next) {
      quota.fallback = { keyProvider: next.key.provider, keyName: next.key.name, model: next.model }
      return { kind: 'apiKey', key: next.key, model: next.model, chosen: false, fallback: 'quota', quota }
    }
    return { kind: 'subscription', binding, ...state, quota }
  }
  if (!selected && (preference.key || preference.selected)) {
    const next = await (await import('./points-fallback')).pointsFallback(pool as Pool, scope, cached.fallback)
    if (next?.kind === 'api_key') {
      const key = keys.find(item => item.id === next.keyId && apiKeyServesBotModel(item, next.model))
      if (key) return { kind: 'apiKey', key, model: next.model, chosen: false, fallback: 'preference' }
    }
    if (next?.kind === 'subscription') {
      const nextBinding = await settings.chatBinding(scope, next.bindingId)
      if (nextBinding) return withQuota(nextBinding)
    }
  }
  // A subscription serves its owner only (decision 2026-11-17): only their own is a default.
  if (binding) return withQuota(binding)
  // No silent default (decision 2026-11-15-1900): the person's own 优先使用的模型 may still name one; else they choose.
  const next = await (await import('./points-fallback')).pointsFallback(pool as Pool, scope, cached.fallback)
  if (next?.kind === 'api_key') {
    const key = keys.find(item => item.id === next.keyId && apiKeyServesBotModel(item, next.model))
    if (key) return { kind: 'apiKey', key, model: next.model, chosen: false, fallback: 'preference' }
  }
  if (next?.kind === 'subscription') {
    const nextBinding = await settings.chatBinding(scope, next.bindingId)
    if (nextBinding) return { kind: 'subscription', binding: nextBinding, chosen: false, fallback: 'preference' }
  }
  // A self-hosted server offers exactly the one model its administrator
  // configured: there is nothing to choose, so a chat with no choice uses it.
  // Mikka Cloud keeps no silent default (decision 2026-11-15-1900).
  if (!isCloudEdition()) {
    const offered = await (await import('./credits-models')).creditsModels(scope.ownerId)
    if (offered.length === 1 && await hostedAllowed()) return hosted(state, offered[0].id)
  }
  return { kind: 'none', ...state }
}
