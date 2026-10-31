/*
 * The settings screen's only door to the execution settings on the server,
 * typed with the names #537 implies: task `defaults` (place, harness, model,
 * whenDeviceOffline), label rules, and each Bot's model plus whenQuotaExhausted.
 *
 * Today it shims the actions in app/actions/execution-settings.ts. Every shim
 * is marked `// #537:` with what to delete when the backend lands.
 */
import {
  createExecutionRule, deleteExecutionRule, getBotModel, listBotModels, listExecutionPlaces, listExecutionRules, redetectDevice, setBotModel, updateExecutionRule,
} from '@/app/actions/execution-settings'
import type { ExecutionRule } from '@/lib/execution-rules'
import { initialExecution, retarget, type BotModelRow, type ExecutionChoice, type ExecutionPlace, type RuleHarness } from '@/lib/execution-settings-view'

export type WhenDeviceOffline = 'wait' | 'cloud'
export type WhenQuotaExhausted = 'stop' | 'switchAccount'
export interface TaskDefaults extends ExecutionChoice { whenDeviceOffline: WhenDeviceOffline }
export interface LabelRule extends ExecutionChoice { id: string; label: string; position: number }
export interface ExecutionSettingsData { defaults: TaskDefaults; rules: LabelRule[]; whenQuotaExhausted: WhenQuotaExhausted }

/** What the server holds. A field it leaves `null` has no saved value yet. */
export interface StoredExecutionSettings {
  defaults: Partial<ExecutionChoice> & { whenDeviceOffline: WhenDeviceOffline }
  rules: ExecutionRule[]
  whenQuotaExhausted: WhenQuotaExhausted
}

const DEFAULT_ID = 'default'
const concrete = (value: string) => value === 'auto' ? undefined : value

export async function readExecutionSettings(): Promise<StoredExecutionSettings> {
  const rows = await listExecutionRules()
  const fallback = rows.find(rule => rule.id === DEFAULT_ID)
  return {
    // #537: the server still returns its fixed 自动 default row; read the saved default from `defaults` once it exists.
    defaults: { place: concrete(fallback?.place ?? 'auto'), harness: concrete(fallback?.harness ?? 'auto') as RuleHarness | undefined, model: concrete(fallback?.model ?? 'auto'), whenDeviceOffline: 'wait' },
    rules: rows.filter(rule => rule.id !== DEFAULT_ID),
    // #537: no stored fallback yet; read `whenQuotaExhausted` from the server.
    whenQuotaExhausted: 'stop',
  }
}

/**
 * Concrete values for the screen. #537 makes the server return them;
 * until then a missing default, or a rule saved as 自动, takes the initial value.
 */
export function executionSettingsView(stored: StoredExecutionSettings, places: readonly ExecutionPlace[], accounts: readonly BotModelRow[]): ExecutionSettingsData {
  // #537: delete this derivation once the server returns and saves the suggested default.
  const initial = initialExecution(places, accounts)
  const fill = <V extends { place?: string; harness?: string; model?: string }>(value: V) => {
    const place = concrete(value.place ?? 'auto') ?? initial.place
    const harness = concrete(value.harness ?? 'auto') ?? (place === initial.place ? initial.harness : '')
    return retarget(places, { place, harness, model: concrete(value.model ?? 'auto') ?? '' }) as ExecutionChoice
  }
  const defaults = { ...stored.defaults, ...fill(stored.defaults) }
  return {
    defaults,
    rules: stored.rules.map(rule => ({ ...rule, label: rule.label ?? '', ...fill(rule) })),
    whenQuotaExhausted: stored.whenQuotaExhausted,
  }
}

const ruleValue = (label: string, value: ExecutionChoice) => ({ label, place: value.place, harness: value.harness, model: value.model })

export async function saveDefaults(value: TaskDefaults): Promise<void> {
  void value
  // #537: no action saves the default or whenDeviceOffline yet; call updateExecutionDefaults(value) here.
  throw new Error('validationGeneric')
}

export async function saveWhenQuotaExhausted(value: WhenQuotaExhausted): Promise<void> {
  void value
  // #537: no action saves whenQuotaExhausted yet; call its action here.
  throw new Error('validationGeneric')
}

export async function addRule(label: string, value: ExecutionChoice) {
  await createExecutionRule(ruleValue(label, value))
}

export async function updateRule(id: string, label: string, value: ExecutionChoice) {
  await updateExecutionRule(id, ruleValue(label, value))
}

export async function removeRule(id: string) {
  await deleteExecutionRule(id)
}

export const listPlaces = async () => (await listExecutionPlaces()) as ExecutionPlace[]
export const listAccountModels = async () => (await listBotModels()) as BotModelRow[]
export const readBotModel = async (botId: string | null) => (await getBotModel(botId)) ?? null
export const saveBotModel = (botId: string | null, bindingId: string) => setBotModel(botId, bindingId)
export const redetect = (deviceIds: string[]) => Promise.all(deviceIds.map(id => redetectDevice(id)))
