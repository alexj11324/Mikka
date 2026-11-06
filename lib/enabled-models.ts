'use client'

import { useCallback, useSyncExternalStore } from 'react'
import { modelDisplayName } from '@/lib/model-display-name'

/**
 * Which of a credential's models are enabled (design prototype, 2026-11-06).
 * The real store is a backend task; this keeps the choice in the browser so the
 * full-page design can show the flow end to end: a model switched off here
 * leaves the bot model picker and 优先使用的模型.
 *
 * Defaults: a subscription enables the newest model of each series; an API key
 * enables the models it had when it was added, and a model that appears later
 * stays off until someone turns it on.
 */
export type ModelSourceKind = 'subscription' | 'api_key' | 'hosted'
interface SourceChoice { on: string[]; off: string[]; seen?: string[]; autoEnable?: boolean }
type Store = Record<string, SourceChoice>

const KEY = 'mikka:enabled-models'
const EVENT = 'mikka:enabled-models'
const EMPTY: Store = {}
let cache: { raw: string | null; store: Store } = { raw: null, store: EMPTY }

function read(): Store {
  let raw: string | null = null
  try { raw = localStorage.getItem(KEY) } catch { return cache.store }
  if (raw === cache.raw) return cache.store
  let store: Store = {}
  try { store = raw ? JSON.parse(raw) as Store : {} } catch { store = {} }
  cache = { raw, store }
  return store
}

function write(store: Store) {
  try { localStorage.setItem(KEY, JSON.stringify(store)) } catch { /* private window: the choice lasts this page */ }
  cache = { raw: JSON.stringify(store), store }
  window.dispatchEvent(new Event(EVENT))
}

const subscribe = (notify: () => void) => {
  window.addEventListener(EVENT, notify)
  window.addEventListener('storage', notify)
  return () => { window.removeEventListener(EVENT, notify); window.removeEventListener('storage', notify) }
}

const versionKey = (version: string | null) => (version ?? '').replace(/^v/i, '').split('.').map(Number)
const newer = (a: string | null, b: string | null) => {
  const x = versionKey(a), y = versionKey(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d > 0 }
  return false
}

/** The newest model of each series; an unrecognised model counts as its own series. */
export function newestOfEachSeries(models: readonly string[]): Set<string> {
  const best = new Map<string, { id: string; version: string | null }>()
  for (const id of models) {
    const { family, version, name } = modelDisplayName(id)
    const variant = family ? name.replace(family, '').replace(version ?? '', '').replace(/[-\s]+/g, ' ').trim() : ''
    const key = family ? `${family}:${variant}` : id
    const current = best.get(key)
    if (!current || newer(version, current.version)) best.set(key, { id, version })
  }
  return new Set([...best.values()].map(item => item.id))
}

export interface EnabledModels {
  /** The enabled subset of `models`, in their order. */
  enabled: (sourceId: string, kind: ModelSourceKind, models: readonly string[]) => string[]
  isEnabled: (sourceId: string, kind: ModelSourceKind, models: readonly string[], model: string) => boolean
  /** Models this key reported after it was added, not yet turned on or off. */
  fresh: (sourceId: string, kind: ModelSourceKind, models: readonly string[]) => string[]
  autoEnable: (sourceId: string, kind: ModelSourceKind) => boolean
  set: (sourceId: string, model: string, on: boolean) => void
  setAll: (sourceId: string, models: readonly string[], on: boolean) => void
  setAutoEnable: (sourceId: string, on: boolean) => void
}

export function useEnabledModels(): EnabledModels {
  const store = useSyncExternalStore<Store>(subscribe, read, () => EMPTY)
  const defaults = useCallback((kind: ModelSourceKind, models: readonly string[], choice?: SourceChoice) => kind === 'subscription' ? newestOfEachSeries(models)
    : kind === 'api_key' && choice?.seen ? new Set(choice.seen) : new Set(models), [])
  const isEnabled = useCallback((sourceId: string, kind: ModelSourceKind, models: readonly string[], model: string) => {
    const choice = store[sourceId]
    if (choice?.off.includes(model)) return false
    if (choice?.on.includes(model)) return true
    return defaults(kind, models, choice).has(model)
  }, [store, defaults])
  const update = (sourceId: string, change: (choice: SourceChoice) => SourceChoice) => {
    const current = read()
    write({ ...current, [sourceId]: change(current[sourceId] ?? { on: [], off: [] }) })
  }
  return {
    isEnabled,
    enabled: (sourceId, kind, models) => models.filter(model => isEnabled(sourceId, kind, models, model)),
    fresh: (sourceId, kind, models) => {
      const choice = store[sourceId]
      if (kind !== 'api_key' || !choice?.seen) return []
      return models.filter(model => !choice.seen!.includes(model) && !choice.on.includes(model) && !choice.off.includes(model))
    },
    autoEnable: (sourceId, kind) => store[sourceId]?.autoEnable ?? kind !== 'api_key',
    set: (sourceId, model, on) => update(sourceId, choice => ({ ...choice, on: on ? [...new Set([...choice.on, model])] : choice.on.filter(item => item !== model), off: on ? choice.off.filter(item => item !== model) : [...new Set([...choice.off, model])] })),
    setAll: (sourceId, models, on) => update(sourceId, choice => ({ ...choice, on: on ? [...new Set([...choice.on, ...models])] : choice.on.filter(item => !models.includes(item)), off: on ? choice.off.filter(item => !models.includes(item)) : [...new Set([...choice.off, ...models])] })),
    setAutoEnable: (sourceId, on) => update(sourceId, choice => ({ ...choice, autoEnable: on })),
  }
}
