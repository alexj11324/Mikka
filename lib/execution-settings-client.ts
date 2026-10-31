/*
 * The settings screen's only door to the execution settings on the server
 * (app/actions/execution-settings.ts): task `defaults` (the label-less rule plus
 * whenDeviceOffline), label rules, and each Bot's model plus whenQuotaExhausted.
 */
import {
  createExecutionRule, deleteExecutionRule, getBotModel, getExecutionFallbacks, listBotModels, listExecutionPlaces, listExecutionRules, redetectDevice, setBotModel, updateExecutionFallbacks, updateExecutionRule,
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

/** The server's id for the label-less default rule. */
const DEFAULT_ID = 'default'
const concrete = (value: string) => value === 'auto' ? undefined : value

export async function readExecutionSettings(): Promise<StoredExecutionSettings> {
  const [rows, fallbacks] = await Promise.all([listExecutionRules(), getExecutionFallbacks()])
  const fallback = rows.find(rule => rule.label === null)
  return {
    defaults: { place: concrete(fallback?.place ?? 'auto'), harness: concrete(fallback?.harness ?? 'auto') as RuleHarness | undefined, model: concrete(fallback?.model ?? 'auto'), whenDeviceOffline: fallbacks.whenDeviceOffline },
    rules: rows.filter(rule => rule.label !== null),
    whenQuotaExhausted: fallbacks.whenQuotaExhausted,
  }
}

/**
 * Concrete values for the screen. The server saves a suggested default; a value it
 * could not suggest yet (no device or account), or an older 自动 row, takes the initial value.
 */
export function executionSettingsView(stored: StoredExecutionSettings, places: readonly ExecutionPlace[], accounts: readonly BotModelRow[]): ExecutionSettingsData {
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
  await updateExecutionRule(DEFAULT_ID, { label: null, place: value.place, harness: value.harness as RuleHarness, model: value.model })
  const fallbacks = await getExecutionFallbacks()
  if (fallbacks.whenDeviceOffline !== value.whenDeviceOffline) await updateExecutionFallbacks({ ...fallbacks, whenDeviceOffline: value.whenDeviceOffline })
}

export async function saveWhenQuotaExhausted(value: WhenQuotaExhausted): Promise<void> {
  await updateExecutionFallbacks({ ...await getExecutionFallbacks(), whenQuotaExhausted: value })
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
