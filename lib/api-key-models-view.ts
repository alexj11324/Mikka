import { modelDisplayName } from './model-display-name'

export type ApiKeyModelItem = {
  id: string
  /** Human-readable display name when recognized by Mikka's model catalog, or raw id when unrecognized. */
  displayName: string
  /** True when Mikka recognizes the model series; unrecognized models returned by `/models` stay selectable by id. */
  known: boolean
  enabled: boolean
}

export type ApiKeyModelsSelectionState = 'checked' | 'indeterminate' | 'unchecked'

export type ApiKeyModelsView = {
  items: ApiKeyModelItem[]
  enabledCount: number
  totalCount: number
  selectAllState: ApiKeyModelsSelectionState
}

/**
 * Projects an API key's discovered models into the Settings "Models available for this key" dialog
 * (Figma "Chat+右栏" section 18, node 1381:4660, #2925 item 5).
 * Recognized models come first, followed by unrecognized models returned by the provider's `/models`.
 * When backend #2938 adds authoritative `known` flags via `GET /connections/:id/models`, callers
 * can pass `known` directly and it takes precedence over `modelDisplayName(id).family !== null`.
 */
export function buildApiKeyModelsView(
  models: readonly { id: string; enabled: boolean; known?: boolean }[],
): ApiKeyModelsView {
  const recognized: ApiKeyModelItem[] = []
  const unrecognized: ApiKeyModelItem[] = []

  for (const model of models) {
    const parsed = modelDisplayName(model.id)
    const known = typeof model.known === 'boolean' ? model.known : parsed.family !== null
    const item: ApiKeyModelItem = {
      id: model.id,
      displayName: known ? parsed.name : model.id,
      known,
      enabled: model.enabled,
    }
    if (known) recognized.push(item)
    else unrecognized.push(item)
  }

  const items = [...recognized, ...unrecognized]
  const totalCount = items.length
  const enabledCount = items.filter(item => item.enabled).length
  const selectAllState: ApiKeyModelsSelectionState =
    totalCount > 0 && enabledCount === totalCount
      ? 'checked'
      : enabledCount > 0
        ? 'indeterminate'
        : 'unchecked'

  return { items, enabledCount, totalCount, selectAllState }
}
