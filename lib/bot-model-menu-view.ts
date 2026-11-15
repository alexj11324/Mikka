/*
 * The model picker in a bot's composer (decision 2026-10-31-2330): what the
 * server sends to the web and mobile chips. No server imports, so both clients
 * and tests can read it.
 */

/** The menu's id for Mikka 默认; `bot_model_choices` stores it as a row with no binding. */
export const HOSTED_CHOICE = '00000000-0000-0000-0000-000000000000'

/** The menu's id for a model an API key or custom provider serves (C22): `apikey:<keyId>:<model>`. */
export const apiKeyOptionId = (keyId: string, model: string) => `apikey:${keyId}:${model}`
export function parseApiKeyOption(id: string): { keyId: string; model: string } | null {
  const match = /^apikey:([0-9a-f-]{36}):(.+)$/i.exec(id)
  return match ? { keyId: match[1], model: match[2] } : null
}

/** The menu's groups, in the order they appear. */
export type BotModelGroupKind = 'hosted' | 'subscription' | 'apiKey' | 'shared'

export interface BotModelMenuOption {
  /** What `chooseBotModel` saves: a binding id, HOSTED_CHOICE, or an API key model (`apiKeyOptionId`). */
  id: string
  /** The model's id as its provider names it; empty for Mikka 默认. */
  modelId: string
  /** `claude`, `codex`, `mikka` for the hosted model, or an API key's provider (`anthropic`, `deepseek`, `custom`…). */
  provider: string
  /** A community default uses cloud credits or the administrator's own provider. */
  hostedSource?: 'cloud' | 'self-hosted'
}

export interface BotModelMenuGroup {
  kind: BotModelGroupKind
  /** The subscription's provider (`claude` | `codex`), for its heading. */
  provider?: string
  /** The subscription's plan, e.g. `Max`, when the provider reports one. */
  plan?: string | null
  /** For a shared credential: the name of the member it belongs to. */
  owner?: string
  /** Account label or key name and masked suffix; never a credential value. */
  credentialLabel?: string
  /** Mikka 默认: the points it can spend in this chat's workspace (its own and members' shared ones). */
  points?: number
  /** Mikka 默认 with no points yet: the free messages left before a card is needed. */
  trialLeft?: number
  hostedSource?: 'cloud' | 'self-hosted'
  options: BotModelMenuOption[]
}

export interface BotModelCurrent extends BotModelMenuOption {
  kind: BotModelGroupKind
  /** The person picked it. False: it is what the resolution order gives today. */
  chosen: boolean
  /** True only when this credential is confirmed usable. */
  available: boolean
  /** Unknown or stale subscription quota remains selectable for a new check. */
  availability?: 'available' | 'checking' | 'exhausted'
  credentialLabel?: string
  /** The effective next choice differs from the stored preference. */
  fallback?: 'preference' | 'points' | 'quota'
  /**
   * Set when the subscription ran out of quota. With a fallback key, the rest
   * of `current` is that key's model, which the next turn uses.
   */
  quota?: BotModelQuota
}

/** A subscription out of quota, as the composer warns before sending (decision 2026-11-01-quota-exhausted). */
export interface BotModelQuota {
  /** The used-up subscription's provider (`claude` | `codex`). */
  subscription: string
  /** The subscription's plan, e.g. `Max`. */
  plan: string | null
  /** When the used-up window resets; null when the provider did not say. */
  resetsAt: string | null
  /** 订阅额度用完后，自动改用 API Key is on and the person has a key: the next turn runs on it. */
  fallback: { keyProvider: string; keyName: string | null; model: string } | null
}

export interface BotModelMenu {
  groups: BotModelMenuGroup[]
  current: BotModelCurrent
}

/** The option the chip and the menu's check mark stand for. */
export function isCurrent(menu: Pick<BotModelMenu, 'current'>, option: BotModelMenuOption) {
  return menu.current.id === option.id
}

/**
 * The menu as it reads the moment the person picks `id`, before the server answers: the chip and the check mark move
 * at once. Only what the menu already knows is claimed (the option, its group's kind and label); a fallback or a used-up
 * quota is the server's to say when it answers. Null when the menu has no such option.
 */
export function withChosenModel(menu: BotModelMenu, id: string): BotModelMenu | null {
  for (const group of menu.groups) {
    const option = group.options.find(item => item.id === id)
    if (option) return { ...menu, current: { ...option, kind: group.kind, chosen: true, available: true, ...(group.credentialLabel ? { credentialLabel: group.credentialLabel } : {}) } }
  }
  return null
}

/**
 * The person's own subscription a refused Mikka 默认 turn can move to (decision
 * 2240): the first in the menu's order, its first model. Null with none.
 */
export function ownSubscriptionOption(menu: Pick<BotModelMenu, 'groups'>): { option: string; provider: string; plan: string | null } | null {
  const group = menu.groups.find(item => item.kind === 'subscription' && item.owner === undefined && item.options.length > 0)
  return group ? { option: group.options[0].id, provider: group.provider ?? group.options[0].provider, plan: group.plan ?? null } : null
}
