/*
 * The settings screen's only door to the execution settings on the server
 * (app/actions/execution-settings.ts): task `defaults` (the label-less rule plus
 * whenDeviceOffline), label rules, and whenQuotaExhausted. Each bot's model is picked in its chat
 * (components/coordinator/bot-model-picker.tsx).
 */
import {
  createExecutionRule, deleteExecutionRule, redetectDevice, updateExecutionFallbacks, updateExecutionRule,
  type getExecutionFallbacks, type listExecutionRules,
} from '@/app/actions/execution-settings'
import { settingsRead } from '@/lib/settings-read'
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
  // First reads go over GET (`/api/settings/[read]`), so they never queue in front of a save.
  const [rows, fallbacks] = await Promise.all([
    settingsRead<Awaited<ReturnType<typeof listExecutionRules>>>('execution-rules'),
    settingsRead<Awaited<ReturnType<typeof getExecutionFallbacks>>>('execution-fallbacks'),
  ])
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

/** The label-less default rule: where, with which Agent and model, a task without a matching label runs. */
export async function saveDefaultRule(value: ExecutionChoice): Promise<void> {
  await updateExecutionRule(DEFAULT_ID, { label: null, place: value.place, harness: value.harness as RuleHarness, model: value.model })
}

/** Both fallbacks in one write, from what the screen shows, so one change is one request. */
export async function saveFallbacks(value: { whenDeviceOffline: WhenDeviceOffline; whenQuotaExhausted: WhenQuotaExhausted }): Promise<void> {
  await updateExecutionFallbacks(value)
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

export const listPlaces = () => settingsRead<ExecutionPlace[]>('execution-places')
export const listAccountModels = () => settingsRead<BotModelRow[]>('bot-models')

/** Bot 与 Agents' SWR keys; settings-prefetch fills the same ones. */
export const BOT_AGENTS_KEYS = { settings: 'execution-settings', places: 'execution-places', accounts: 'bot-models' } as const

/** The section's first reads, by key, for settings-prefetch. */
export const botAgentsReads = (): [key: string, read: () => Promise<unknown>][] => [
  [BOT_AGENTS_KEYS.settings, readExecutionSettings],
  [BOT_AGENTS_KEYS.places, listPlaces],
  [BOT_AGENTS_KEYS.accounts, listAccountModels],
]
export const redetect = (deviceIds: string[]) => Promise.all(deviceIds.map(id => redetectDevice(id)))
