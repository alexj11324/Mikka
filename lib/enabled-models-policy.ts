import { latestDefaultCandidates } from './model-order-plan'

export interface ModelToggle { enabled: boolean; fresh: boolean; manual: boolean }
export interface ModelSettings { autoEnable: boolean; models: Record<string, ModelToggle> }

/** Same release/family selection as #1515; no second version parser. */
export function reconcileSubscriptionModels(ids: string[], previous?: ModelSettings | null): ModelSettings {
  const latest = new Set(latestDefaultCandidates(ids.map(model => ({ model, name: model,
    harness: 'claude_code' as const, source: { kind: 'subscription' as const, connectionId: 'catalogue' } }))).map(item => item.model))
  const autoEnable = previous?.autoEnable ?? true
  const models: Record<string, ModelToggle> = Object.create(null)
  // Retain choices for temporarily absent models, including explicit disabled choices.
  for (const [id, value] of Object.entries(previous?.models ?? {})) models[id] = value
  for (const id of ids) {
    const prior = previous?.models[id]
    models[id] = prior?.manual ? prior : { enabled: previous && !autoEnable ? prior?.enabled ?? false : latest.has(id), fresh: false, manual: false }
  }
  return { autoEnable, models }
}

export function modelEnabled(settings: ModelSettings | null | undefined, id: string) {
  return settings?.models[id]?.enabled ?? true
}
