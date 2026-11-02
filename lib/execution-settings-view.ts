import type { HarnessInfo } from '@mikka/protocol/harness'

/** The harnesses a rule names. There is no 自动: every value is concrete (#537). */
export const RULE_HARNESSES = ['claude_code', 'codex', 'cursor'] as const
export type RuleHarness = (typeof RULE_HARNESSES)[number]

/**
 * A harness as a device reports it. A model slot carries what it resolves to on that device,
 * e.g. a Claude Code slot → whatever model its environment maps that slot to.
 * Rules store the slot; the screen shows only the resolved model's name.
 */
export type HarnessReport = HarnessInfo

/** One entry of `listExecutionPlaces()`: an owner device, or the cloud option. */
export interface ExecutionPlace {
  id: string
  kind?: 'cloud'
  name?: string | null
  deviceType?: 'laptop' | 'server' | null
  enabled?: boolean
  online: boolean
  harnesses: HarnessReport[]
  /** Agents whose reported models could not be checked against a connected account (`withAccountModels`). */
  unverified?: RuleHarness[]
}

export type DeviceKind = 'laptop' | 'server' | 'cloud' | 'unknown'

export function placeKind(place: Pick<ExecutionPlace, 'id' | 'kind' | 'deviceType'>): DeviceKind {
  if (place.kind === 'cloud' || place.id === 'cloud') return 'cloud'
  return place.deviceType === 'laptop' || place.deviceType === 'server' ? place.deviceType : 'unknown'
}

const isRuleHarness = (value: string): value is RuleHarness => (RULE_HARNESSES as readonly string[]).includes(value)
const localDevices = (places: readonly ExecutionPlace[]) => places.filter(place => placeKind(place) !== 'cloud')
const installed = (place: ExecutionPlace, harness: string) => place.harnesses.some(info => info.harness === harness && info.installed)

/**
 * Harnesses offered at a place: what the device detected, installed ones only. Mikka Cloud
 * offers what `withCloudModels` gave it: the Agents of the connected accounts.
 */
export function harnessOptions(places: readonly ExecutionPlace[], place: string): RuleHarness[] {
  const target = places.find(item => item.id === place)
  if (!target) return [...RULE_HARNESSES]
  return RULE_HARNESSES.filter(harness => installed(target, harness))
}

/** Which account runs which Agent on Mikka Cloud, as the server checks a cloud rule. */
const CLOUD_PROVIDERS = { claude_code: 'claude', codex: 'codex' } as const

/**
 * Mikka Cloud runs an Agent on the person's own subscription, so its Agents and models are
 * the connected accounts' (Claude → Claude Code, ChatGPT → Codex), never what a device reports.
 */
export function withCloudModels(places: readonly ExecutionPlace[], accounts: readonly Pick<BotModelRow, 'provider' | 'modelId'>[]): ExecutionPlace[] {
  return places.map(place => placeKind(place) !== 'cloud' ? place : {
    ...place,
    harnesses: (Object.entries(CLOUD_PROVIDERS) as [RuleHarness, string][])
      .map(([harness, provider]) => ({ harness, installed: true, version: null, models: [...new Set(accounts.filter(row => row.provider === provider).map(row => row.modelId))] }))
      .filter(info => info.models.length > 0) as HarnessReport[],
  })
}

/**
 * A device's CLI reports what it can drive, asked with no login (decision 2026-11-02-1300): an
 * account may lack some of those models or have more. A run on a device uses the subscription Mikka
 * hands it, never the device's own login (ADR 0009), so a device's models are those its CLI reported
 * that the connected account's catalogue also lists. A reported slot counts when its id or the
 * model it resolves to is in the catalogue. With no account for that Agent's provider, the reported
 * list stays as reported and the Agent is marked unverified (未与账号核对).
 */
export function withAccountModels(places: readonly ExecutionPlace[], accounts: readonly Pick<BotModelRow, 'provider' | 'modelId'>[]): ExecutionPlace[] {
  return places.map(place => {
    if (placeKind(place) === 'cloud') return place
    const unverified: RuleHarness[] = []
    const harnesses = place.harnesses.map(info => {
      const provider = CLOUD_PROVIDERS[info.harness as keyof typeof CLOUD_PROVIDERS]
      if (!provider || !info.installed) return info
      const catalogue = new Set(accounts.filter(row => row.provider === provider).map(row => row.modelId))
      if (!catalogue.size) { unverified.push(info.harness as RuleHarness); return info }
      const slots = info.modelSlots?.filter(slot => catalogue.has(slot.slot) || catalogue.has(slot.model))
      const models = info.models?.filter(model => catalogue.has(model) || Boolean(slots?.some(slot => slot.slot === model)))
      const kept = new Set([...(models ?? []), ...(slots ?? []).map(slot => slot.slot)])
      const { defaultModelSlot, ...rest } = info
      return {
        ...rest,
        ...(info.models ? { models } : {}),
        ...(info.modelSlots ? { modelSlots: slots } : {}),
        ...(defaultModelSlot && kept.has(defaultModelSlot) ? { defaultModelSlot } : {}),
      }
    })
    return { ...place, harnesses, ...(unverified.length ? { unverified } : {}) }
  })
}

/** Whether a place's models for an Agent were not checked against an account (未与账号核对). */
export const modelsUnverified = (places: readonly ExecutionPlace[], place: string, harness: string) =>
  Boolean(places.find(item => item.id === place)?.unverified?.includes(harness as RuleHarness))

/** A model a rule can pick: `value` is stored (a slot or a reported id), `name` is shown. */
export interface ModelOption { value: string; name: string; isDefault?: boolean }

/**
 * Models a harness reported at a place, by slot when it reports slots; on Mikka Cloud, the
 * connected account's models (`withCloudModels`). Only what the CLI or daemon reported: no
 * model name is written here, and nothing stands in when it reported none (Alex, 2026-11-02).
 */
export function modelOptions(places: readonly ExecutionPlace[], place: string, harness: string): ModelOption[] {
  const devices = places.filter(item => item.id === place)
  const options = new Map<string, ModelOption>()
  for (const info of devices.flatMap(device => device.harnesses.filter(item => item.harness === harness && item.installed))) {
    const reported = info.modelSlots?.length
      ? info.modelSlots.map(slot => ({ value: slot.slot, name: slot.name, isDefault: slot.slot === info.defaultModelSlot }))
      : (info.models ?? []).map(model => ({ value: model, name: model, isDefault: model === info.defaultModelSlot }))
    for (const option of reported) if (!options.has(option.value)) options.set(option.value, option)
  }
  return [...options.values()]
}

/** The model a harness uses unless the person picks another: the one its CLI marks default; none when it marks none, so the person picks. */
export function defaultModel(options: readonly ModelOption[]): ModelOption | undefined {
  return options.find(option => option.isDefault)
}

/** A stored model the place no longer reports: shown as unavailable, never offered as a choice. */
export function modelUnavailable(places: readonly ExecutionPlace[], place: string, harness: string, model: string): boolean {
  return Boolean(model) && !modelOptions(places, place, harness).some(option => option.value === model)
}

/** What a stored model value shows: the model its slot resolves to there, or the value itself. */
export function modelName(places: readonly ExecutionPlace[], place: string, harness: string, model: string): string {
  return modelOptions(places, place, harness).find(option => option.value === model)?.name ?? model
}

/** Local devices a 重新检测 at this place should ask; cloud has nothing of its own, so it asks every device. */
export function redetectTargets(places: readonly ExecutionPlace[], place: string): string[] {
  if (place === 'cloud') return localDevices(places).map(device => device.id)
  return places.some(item => item.id === place && placeKind(item) !== 'cloud') ? [place] : []
}

/**
 * After the place or harness changes, keep the harness and model only when the
 * new place still offers them; otherwise take the first harness there and its
 * default model, or no model when it marks none. An old model never carries over.
 */
export function retarget<V extends { place: string; harness: string; model: string }>(places: readonly ExecutionPlace[], value: V): V {
  const harnesses = harnessOptions(places, value.place)
  const harness = isRuleHarness(value.harness) && harnesses.includes(value.harness) ? value.harness : harnesses[0] ?? value.harness
  const models = modelOptions(places, value.place, harness)
  const model = models.some(option => option.value === value.model) ? value.model : defaultModel(models)?.value ?? ''
  return { ...value, harness, model }
}

export interface ExecutionChoice { place: string; harness: RuleHarness; model: string }

/**
 * The concrete default a person starts with (Alex, #537):
 * - a Claude subscription → Claude Code on their server, else any online device, else the cloud;
 * - otherwise a ChatGPT/Codex subscription → Codex the same way;
 * - otherwise the first online device with a harness, else the cloud.
 * The model is the one the harness's CLI marks default there; none when it marks none, so the person picks.
 * `accounts` are the connected subscriptions' bound models (`listBotModels()`).
 */
export function initialExecution(places: readonly ExecutionPlace[], accounts: readonly Pick<BotModelRow, 'provider' | 'modelId'>[]): ExecutionChoice {
  const online = localDevices(places).filter(device => device.online && device.enabled !== false)
  const ordered = [...online.filter(device => placeKind(device) === 'server'), ...online.filter(device => placeKind(device) !== 'server')]
  const subscription = (['claude', 'codex'] as const).find(provider => accounts.some(row => row.provider === provider))
  const harness: RuleHarness = subscription === 'claude' ? 'claude_code' : subscription === 'codex' ? 'codex'
    : RULE_HARNESSES.find(item => ordered.some(device => installed(device, item))) ?? 'claude_code'
  const place = ordered.find(device => installed(device, harness))?.id ?? 'cloud'
  const model = defaultModel(modelOptions(places, place, harness))?.value ?? ''
  return { place, harness, model }
}

export type ModelProvider = 'claude' | 'openai' | 'unknown'

/**
 * The provider whose mark a model carries (R-74), read from the model id and,
 * failing that, from the account or harness it came through.
 */
export function modelProvider(modelId: string, source?: string | null): ModelProvider {
  const id = modelId.toLowerCase()
  if (/(^|[^a-z])(claude|opus|sonnet|haiku)/.test(id)) return 'claude'
  if (/^(gpt|o\d|codex|chatgpt|openai)/.test(id) || /(^|[^a-z])(gpt|openai)/.test(id)) return 'openai'
  const via = source?.toLowerCase() ?? ''
  if (via === 'claude' || via === 'claude_code' || via.startsWith('claude_')) return 'claude'
  if (via === 'codex' || via === 'openai' || via.startsWith('codex_') || via.startsWith('openai_')) return 'openai'
  return 'unknown'
}

/** One row of `listBotModels()`. */
export interface BotModelRow {
  bindingId: string
  consumerId: string
  modelId: string
  route: string
  connectionId: string
  provider: string
}

export interface BotModelOption { bindingId: string; modelId: string; key: string }
export interface BotModelAccount { connectionId: string; provider: string; models: BotModelOption[] }

const optionKey = (row: Pick<BotModelRow, 'connectionId' | 'modelId'>) => `${row.connectionId}\u0000${row.modelId}`

/**
 * Models grouped by connected account. Choosing a model for a Bot copies the
 * binding to that Bot, so the same account and model can appear under several
 * bindings; each is listed once.
 */
export function groupBotModels(rows: readonly BotModelRow[]): BotModelAccount[] {
  const accounts = new Map<string, BotModelAccount>()
  for (const row of rows) {
    const account = accounts.get(row.connectionId) ?? { connectionId: row.connectionId, provider: row.provider, models: [] }
    accounts.set(row.connectionId, account)
    const key = optionKey(row)
    if (!account.models.some(model => model.key === key)) account.models.push({ bindingId: row.bindingId, modelId: row.modelId, key })
  }
  return [...accounts.values()]
}

/** The option a Bot's stored binding stands for, or null when it has none (or it is no longer connected). */
export function selectedBotModel(rows: readonly BotModelRow[], bindingId: string | null | undefined): { key: string; modelId: string; provider: string } | null {
  const row = bindingId ? rows.find(item => item.bindingId === bindingId) : undefined
  return row ? { key: optionKey(row), modelId: row.modelId, provider: row.provider } : null
}

/**
 * The model a Bot shows: its saved binding, else the one it starts with — the
 * Claude account's first model, then ChatGPT's (#537). Null only when no account is connected.
 */
export function botModelChoice(rows: readonly BotModelRow[], bindingId: string | null | undefined): { key: string; modelId: string; provider: string } | null {
  const saved = selectedBotModel(rows, bindingId)
  if (saved) return saved
  // #537: the backend will save this as the Bot's binding when none is set; until then it is only shown.
  const first = rows.find(row => row.provider === 'claude') ?? rows.find(row => row.provider === 'codex') ?? rows[0]
  return first ? selectedBotModel(rows, first.bindingId) : null
}
