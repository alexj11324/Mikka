import 'server-only'
import { hostedModelEnabled } from './enabled-models'
import { ActionFailureError } from './action-error'
import type { Pool } from 'pg'
import type { ExecutionSettings, ExecutionSettingsScope } from './execution-settings'
import { HOSTED_CHOICE, type BotModelQuota } from './bot-model-menu-view'
import { apiKeyChatBaseUrl } from './model-api-key-providers'
import { botApiKeyChoice, usableApiKeys, type UsableApiKey } from './model-api-keys'
import { subscriptionAvailability } from './subscription-quota'
import { isCloudEdition } from './edition'

type Settings = Pick<ExecutionSettings, 'chatModels' | 'chatBinding'> & Partial<Pick<ExecutionSettings, 'pooledBindings' | 'sharedChatBinding'>>
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
  | { kind: 'hosted' }
  | { kind: 'subscription'; binding: BotSubscriptionChoice; sharedOwnerId?: string; quota?: BotModelQuota }
  | { kind: 'apiKey'; key: UsableApiKey; model: string; quota?: BotModelQuota }
)

export function apiKeyServesBotModel(key: UsableApiKey, model: string) {
  return Boolean(apiKeyChatBaseUrl(key) && key.models.includes(model))
}

/** Reads the saved preference without creating a default or cloning a binding. */
export async function botModelPreference(pool: Pick<Pool, 'query'>, scope: ExecutionSettingsScope, botId: string | null) {
  const key = await botApiKeyChoice(pool, scope, botId)
  const { rows: [row] } = await pool.query<{ bindingId: string | null }>(
    'SELECT "bindingId" FROM bot_model_choices WHERE "ownerId"=$1 AND "workspaceId"=$2 AND "botKey"=$3',
    [scope.ownerId, scope.workspaceId, botId ?? 'coordinator'],
  )
  // A saved key also has a null binding. Only a row without either explicitly
  // selects Mikka default, which must stay selected even if subscriptions exist.
  return { key, selected: key ? undefined : row ? row.bindingId ?? HOSTED_CHOICE : undefined }
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
  cached: { rows?: BotSubscriptionChoice[]; pooled?: BotSubscriptionChoice[]; keys?: UsableApiKey[]; now?: number } = {},
): Promise<BotModelChoice> {
  const now = cached.now ?? Date.now()
  const keys = cached.keys ?? await usableApiKeys(pool, scope.ownerId, scope.workspaceId)
  const key = preference.key && keys.find(item => item.id === preference.key!.keyId && apiKeyServesBotModel(item, preference.key!.model))
  if (key && preference.key) return { kind: 'apiKey', key, model: preference.key.model, chosen: true }
  const fallback = preference.key ? 'preference' as const : undefined

  // Only hosted choices consume this policy; both consumers share one read per invocation.
  let hostedPolicy: Promise<boolean> | undefined
  const hostedAllowed = () => hostedPolicy ??= hostedModelEnabled(pool, scope.ownerId)
  const hosted = async (state: ChoiceState): Promise<BotModelChoice> => {
    if (!await hostedAllowed()) {
      const next = await (await import('./points-fallback')).pointsFallback(pool as Pool, scope)
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
    if (!isCloudEdition()) return { kind: 'hosted', ...state }
    const { hostedPointsRefusal, pointsFallback } = await import('./points-fallback')
    const next = await hostedPointsRefusal(scope.workspaceId) ? await pointsFallback(pool as Pool, scope) : null
    if (next?.kind === 'api_key') {
      const key = keys.find(item => item.id === next.keyId && apiKeyServesBotModel(item, next.model))
      if (key) return { kind: 'apiKey', key, model: next.model, chosen: false, fallback: 'points' }
    }
    if (next?.kind === 'subscription') {
      const binding = await settings.chatBinding(scope, next.bindingId)
      if (binding) return { kind: 'subscription', binding, chosen: false, fallback: 'points' }
    }
    return { kind: 'hosted', ...state }
  }
  if (preference.selected === HOSTED_CHOICE && !preference.key && await hostedAllowed()) return hosted({ chosen: true })

  const selected = preference.selected && !preference.key ? await settings.chatBinding(scope, preference.selected) : undefined
  const shared = !selected && botId && preference.selected && !preference.key && settings.sharedChatBinding
    ? await settings.sharedChatBinding(scope, botId, preference.selected) : undefined
  // A valid saved binding is already route-checked; only fallback needs the full catalogue.
  const rows = selected || shared ? [] : cached.rows ?? await settings.chatModels(scope)
  const binding = selected ?? rows.find(row => row.provider === 'claude') ?? rows[0]
  const state: ChoiceState = {
    chosen: Boolean(selected || shared),
    ...(!selected && !shared && (preference.selected || fallback) ? { fallback: 'preference' as const } : {}),
  }
  const withQuota = async (binding: BotSubscriptionChoice, sharedOwnerId?: string): Promise<BotModelChoice> => {
    const availability = subscriptionAvailability(binding.quota, binding.modelId, binding.provider === 'codex' ? 'codex' : 'claude', now)
    if (availability.status !== 'exhausted') return { kind: 'subscription', binding, ...state, ...(sharedOwnerId ? { sharedOwnerId } : {}) }
    const quota: BotModelQuota = { subscription: binding.provider, plan: sharedOwnerId ? null : binding.plan ?? null,
      resetsAt: sharedOwnerId ? null : availability.resetsAt, fallback: null }
    const { quotaFallbackKey } = await import('./quota-fallback')
    const next = await quotaFallbackKey(pool, scope.ownerId, scope.workspaceId, binding.modelId)
    if (next) {
      quota.fallback = { keyProvider: next.key.provider, keyName: next.key.name, model: next.model }
      return { kind: 'apiKey', key: next.key, model: next.model, chosen: false, fallback: 'quota', quota }
    }
    return { kind: 'subscription', binding, ...state, ...(sharedOwnerId ? { sharedOwnerId } : {}), quota }
  }
  if (!selected && !shared && (preference.key || preference.selected)) {
    const next = await (await import('./points-fallback')).pointsFallback(pool as Pool, scope)
    if (next?.kind === 'api_key') {
      const key = keys.find(item => item.id === next.keyId && apiKeyServesBotModel(item, next.model))
      if (key) return { kind: 'apiKey', key, model: next.model, chosen: false, fallback: 'preference' }
    }
    if (next?.kind === 'subscription') {
      const nextBinding = await settings.chatBinding(scope, next.bindingId)
      if (nextBinding) return withQuota(nextBinding)
    }
  }
  if (shared) return withQuota(shared, shared.ownerId)
  if (binding) return withQuota(binding)
  // The default remains own subscriptions first, then the first shared one.
  const pooled = botId && settings.pooledBindings ? (cached.pooled ?? await settings.pooledBindings(scope))[0] : undefined
  if (pooled) return withQuota(pooled, pooled.ownerId)
  return hosted(state)
}
