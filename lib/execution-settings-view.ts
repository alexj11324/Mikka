import type { HarnessInfo } from '@mikka/protocol/harness'

/** The harnesses a rule names. There is no 自动: every value is concrete (#537). */
export const RULE_HARNESSES = ['claude_code', 'codex', 'cursor'] as const
export type RuleHarness = (typeof RULE_HARNESSES)[number]

/**
 * A harness as a device reports it. A model slot carries what it resolves to on that device,
 * e.g. Claude Code's `opus` → whatever `ANTHROPIC_DEFAULT_OPUS_MODEL` maps it to.
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
 * Harnesses offered at a place: what the device detected, installed ones only.
 * Cloud reports none of its own, so it offers every harness a rule can name.
 */
export function harnessOptions(places: readonly ExecutionPlace[], place: string): RuleHarness[] {
  const device = place === 'cloud' ? null : places.find(item => item.id === place)
  if (!device) return [...RULE_HARNESSES]
  return RULE_HARNESSES.filter(harness => installed(device, harness))
}

/** A model a rule can pick: `value` is stored (a slot or a reported id), `name` is shown. */
export interface ModelOption { value: string; name: string; isDefault?: boolean }

/** Claude Code's slot a new default uses (Alex, #537). */
export const CLAUDE_CODE_DEFAULT_SLOT = 'opus'

/**
 * Models a harness reported at a place, by slot when it reports slots. Cloud
 * reports none of its own, so it offers what that harness reports on the
 * person's devices. Nothing is hard-coded.
 */
export function modelOptions(places: readonly ExecutionPlace[], place: string, harness: string): ModelOption[] {
  const devices = place === 'cloud' ? localDevices(places) : places.filter(item => item.id === place)
  const options = new Map<string, ModelOption>()
  for (const info of devices.flatMap(device => device.harnesses.filter(item => item.harness === harness && item.installed))) {
    const reported = info.modelSlots?.length
      ? info.modelSlots.map(slot => ({ value: slot.slot, name: slot.name, isDefault: slot.slot === info.defaultModelSlot }))
      : (info.models ?? []).map(model => ({ value: model, name: model }))
    for (const option of reported) if (!options.has(option.value)) options.set(option.value, option)
  }
  // #537: Claude Code reports no models yet; offer its `opus` slot by name until the daemon reports what it resolves to.
  if (harness === 'claude_code' && options.size === 0) options.set(CLAUDE_CODE_DEFAULT_SLOT, { value: CLAUDE_CODE_DEFAULT_SLOT, name: CLAUDE_CODE_DEFAULT_SLOT })
  return [...options.values()]
}

/** The model a harness uses unless the person picks another: Claude Code's `opus` slot, otherwise the slot the harness marks default. */
export function defaultModel(options: readonly ModelOption[], harness: string): ModelOption | undefined {
  if (harness === 'claude_code') return options.find(option => option.value === CLAUDE_CODE_DEFAULT_SLOT) ?? options[0]
  // #537: until the daemon marks Codex's default slot, the first model it reports stands in for it.
  return options.find(option => option.isDefault) ?? options[0]
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
 * new place still offers them; otherwise take the first harness there and its default model.
 */
export function retarget<V extends { place: string; harness: string; model: string }>(places: readonly ExecutionPlace[], value: V): V {
  const harnesses = harnessOptions(places, value.place)
  const harness = isRuleHarness(value.harness) && harnesses.includes(value.harness) ? value.harness : harnesses[0] ?? value.harness
  const models = modelOptions(places, value.place, harness)
  const model = models.some(option => option.value === value.model) ? value.model : defaultModel(models, harness)?.value ?? value.model
  return { ...value, harness, model }
}

export interface ExecutionChoice { place: string; harness: RuleHarness; model: string }

/**
 * The concrete default a person starts with (Alex, #537):
 * - a Claude subscription → Claude Code on their server, else any online device, else the cloud; its `opus` slot;
 * - otherwise a ChatGPT/Codex subscription → Codex the same way, with its default model;
 * - otherwise the first online device with a harness, else the cloud.
 * `accounts` are the connected subscriptions' bound models (`listBotModels()`).
 */
export function initialExecution(places: readonly ExecutionPlace[], accounts: readonly Pick<BotModelRow, 'provider' | 'modelId'>[]): ExecutionChoice {
  const online = localDevices(places).filter(device => device.online && device.enabled !== false)
  const ordered = [...online.filter(device => placeKind(device) === 'server'), ...online.filter(device => placeKind(device) !== 'server')]
  const subscription = (['claude', 'codex'] as const).find(provider => accounts.some(row => row.provider === provider))
  const harness: RuleHarness = subscription === 'claude' ? 'claude_code' : subscription === 'codex' ? 'codex'
    : RULE_HARNESSES.find(item => ordered.some(device => installed(device, item))) ?? 'claude_code'
  const place = ordered.find(device => installed(device, harness))?.id ?? 'cloud'
  const model = defaultModel(modelOptions(places, place, harness), harness)?.value
    // #537: cloud Codex with no device reporting models falls back to the account's own model.
    ?? accounts.find(row => row.provider === subscription)?.modelId ?? ''
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
