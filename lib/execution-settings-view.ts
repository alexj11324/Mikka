import type { HarnessInfo } from '@mikka/protocol/harness'

/** The harnesses a rule can name; `auto` lets the resolver pick (lib/execution-rules.ts). */
export const RULE_HARNESSES = ['claude_code', 'codex', 'cursor'] as const
export type RuleHarness = (typeof RULE_HARNESSES)[number]

/** One entry of `listExecutionPlaces()`: an owner device, or the cloud option. */
export interface ExecutionPlace {
  id: string
  kind?: 'cloud'
  name?: string | null
  deviceType?: 'laptop' | 'server' | null
  enabled?: boolean
  online: boolean
  harnesses: HarnessInfo[]
}

export type DeviceKind = 'laptop' | 'server' | 'cloud' | 'unknown'

export function placeKind(place: Pick<ExecutionPlace, 'id' | 'kind' | 'deviceType'>): DeviceKind {
  if (place.kind === 'cloud' || place.id === 'cloud') return 'cloud'
  return place.deviceType === 'laptop' || place.deviceType === 'server' ? place.deviceType : 'unknown'
}

const isRuleHarness = (value: string): value is RuleHarness => (RULE_HARNESSES as readonly string[]).includes(value)
const localDevices = (places: readonly ExecutionPlace[]) => places.filter(place => placeKind(place) !== 'cloud')

/**
 * Harnesses offered at a place: what the device detected, installed ones only.
 * Cloud reports none of its own, and `auto` may land on any device or the cloud,
 * so both offer every harness a rule can name.
 */
export function harnessOptions(places: readonly ExecutionPlace[], place: string): RuleHarness[] {
  const device = place === 'auto' || place === 'cloud' ? null : places.find(item => item.id === place)
  if (!device) return [...RULE_HARNESSES]
  return RULE_HARNESSES.filter(harness => device.harnesses.some(info => info.harness === harness && info.installed))
}

/**
 * Models a harness reported at a place. Nothing is hard-coded: Claude Code
 * reports none, cloud reports none, and an automatic harness offers none, so
 * those show only 自动.
 */
export function modelOptions(places: readonly ExecutionPlace[], place: string, harness: string): string[] {
  if (harness === 'auto' || place === 'cloud') return []
  const devices = place === 'auto' ? localDevices(places) : places.filter(item => item.id === place)
  const models = devices.flatMap(device => device.harnesses.filter(info => info.harness === harness && info.installed).flatMap(info => info.models ?? []))
  return [...new Set(models)]
}

/** Local devices a 重新检测 at this place should ask; cloud has nothing to re-detect. */
export function redetectTargets(places: readonly ExecutionPlace[], place: string): string[] {
  if (place === 'cloud') return []
  if (place === 'auto') return localDevices(places).map(device => device.id)
  return places.some(item => item.id === place && placeKind(item) !== 'cloud') ? [place] : []
}

/** After the place changes, keep the harness and model only when the new place still offers them. */
export function retarget<V extends { place: string; harness: string; model: string }>(places: readonly ExecutionPlace[], value: V): V {
  const harness = value.harness === 'auto' || (isRuleHarness(value.harness) && harnessOptions(places, value.place).includes(value.harness)) ? value.harness : 'auto'
  const model = value.model === 'auto' || modelOptions(places, value.place, harness).includes(value.model) ? value.model : 'auto'
  return { ...value, harness, model }
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

/** The option a Bot's stored binding stands for, or null for 自动 (or a binding no longer connected). */
export function selectedBotModel(rows: readonly BotModelRow[], bindingId: string | null | undefined): { key: string; modelId: string; provider: string } | null {
  const row = bindingId ? rows.find(item => item.bindingId === bindingId) : undefined
  return row ? { key: optionKey(row), modelId: row.modelId, provider: row.provider } : null
}
