/*
 * The composer's bot model helpers (decision 2026-11-02-1400 retired the
 * label rules and 任务默认 that also lived here): a model's provider mark, and
 * the connected accounts' models grouped for the picker.
 */

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
