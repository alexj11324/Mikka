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
}

export interface BotModelMenuGroup {
  kind: BotModelGroupKind
  /** The subscription's provider (`claude` | `codex`), for its heading. */
  provider?: string
  /** The subscription's plan, e.g. `Max`, when the provider reports one. */
  plan?: string | null
  /** For a shared credential: the name of the member it belongs to. */
  owner?: string
  options: BotModelMenuOption[]
}

export interface BotModelCurrent extends BotModelMenuOption {
  kind: BotModelGroupKind
  /** The person picked it. False: it is what the resolution order gives today. */
  chosen: boolean
  /** False when the chosen credential was removed, unshared or ran out of quota. */
  available: boolean
  /** Set when it is unavailable because the subscription ran out of quota. */
  quota?: BotModelQuota
}

/** A subscription out of quota, as the composer warns before sending (decision 2026-11-01-quota-exhausted). */
export interface BotModelQuota {
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
  return menu.current.available && menu.current.id === option.id
}
