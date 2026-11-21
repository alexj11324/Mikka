/**
 * The model catalogue (decision 2026-11-15-1900): every model Mikka 额度 can
 * run, named the way Vercel AI Gateway names it (`vendor/model`). Subscription
 * and API-key models map onto the same ids where they correspond.
 *
 * Pure and client-safe: pickers, the mobile app and the dispatcher read it.
 * The live list is read on the server (lib/model-catalog-server.ts); the
 * featured snapshot below keeps builds and tests offline.
 */
import snapshot from './model-catalog-snapshot.json'
import { cleanModelId, modelVendor, type ModelVendor } from './model-display-name'

export interface CatalogModel {
  /** `vendor/model`, as the Gateway names it. */
  id: string
  /** The Gateway's `owned_by` (anthropic, openai, moonshotai, zai…). */
  vendor: string
  /** The Gateway's display name. */
  name: string
  contextWindow: number | null
  maxTokens: number | null
  /** USD per million tokens, the provider's list price. */
  pricing: { input: number; output: number; cacheRead?: number } | null
  tags: string[]
  /** Reasoning efforts the model takes, empty when it has none. */
  reasoning: string[]
}

/** Which CLI a thread runs a model with: Codex for OpenAI's models, Claude Code for every other one. */
export type CatalogHarness = 'codex' | 'claude_code'

/** The curated list a picker shows before a search; the rest of the catalogue is reachable by search. */
export const FEATURED_MODELS = [
  'anthropic/claude-fable-5.2', 'anthropic/claude-opus-5.5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5',
  'anthropic/claude-opus-4.8', 'anthropic/claude-sonnet-4.6',
  'openai/gpt-6.1-sol', 'openai/gpt-6.1-terra', 'openai/gpt-6-luna', 'openai/gpt-6-astra', 'openai/gpt-5.5',
  'openai/gpt-5.3-codex', 'openai/gpt-oss-120b',
  'google/gemini-4-argon', 'google/gemini-4-carbon', 'google/gemini-4-hydrogen', 'google/gemini-3.8-flash', 'google/gemini-3.1-pro-preview',
  'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4.1-flash', 'deepseek/deepseek-r1',
  'moonshotai/kimi-k3.1-pro', 'moonshotai/kimi-k3', 'moonshotai/kimi-k2.7-code',
  'alibaba/qwen3.8-max', 'alibaba/qwen3.8-flash', 'alibaba/qwen3.7-plus',
  'zai/glm-5.3', 'zai/glm-5.3-flash',
  'minimax/minimax-m3', 'minimax/minimax-m3.1-flash',
  'spacexai/grok-4.7', 'spacexai/grok-build-0.1',
  'mistral/mistral-large-4', 'mistral/mistral-medium-3.5', 'mistral/codestral',
  'meta/llama-4-maverick', 'meta/muse-spark-1.3',
] as const

/** The featured models as of the last snapshot (scripts/model-catalog-snapshot.mjs). */
export const CATALOG_SNAPSHOT: readonly CatalogModel[] = snapshot as CatalogModel[]

const CATALOG_ID = /^[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9._:-]*$/
/** A Gateway-shaped id (`vendor/model`), the only kind a Mikka 额度 choice stores. */
export const isCatalogId = (id: string) => id.length <= 128 && CATALOG_ID.test(id)

/** Who makes a model, for its mark: the catalogue's own vendor prefix first, then the name. */
export function vendorOf(id: string): ModelVendor {
  return modelVendor(id)
}

/** The CLI a thread runs this model with (decision 2026-11-15-1630: the harness follows the model). */
export function harnessFor(id: string): CatalogHarness {
  return vendorOf(id) === 'openai' ? 'codex' : 'claude_code'
}

const ANTHROPIC = /^claude-(fable|opus|sonnet|haiku)-(\d+)(?:-(\d+))?$/
/**
 * The catalogue id a subscription or API-key model corresponds to, or null
 * when it has none: `claude-opus-5-5` → `anthropic/claude-opus-5.5`,
 * `gpt-6-luna` → `openai/gpt-6-luna`, `deepseek-v4-pro` → `deepseek/deepseek-v4-pro`.
 * The caller checks the result against the catalogue it holds.
 */
export function catalogIdFor(modelId: string): string | null {
  const trimmed = modelId.trim().toLowerCase()
  if (isCatalogId(trimmed)) return trimmed
  const clean = cleanModelId(trimmed)
  const claude = ANTHROPIC.exec(clean)
  if (claude) return `anthropic/claude-${claude[1]}-${claude[2]}${claude[3] ? `.${claude[3]}` : ''}`
  const prefix: Partial<Record<ModelVendor, string>> = { openai: 'openai', deepseek: 'deepseek', google: 'google', moonshot: 'moonshotai',
    alibaba: 'alibaba', zhipu: 'zai', minimax: 'minimax', mistral: 'mistral', meta: 'meta', xai: 'spacexai' }
  const vendor = prefix[modelVendor(clean)]
  return vendor && clean ? `${vendor}/${clean}` : null
}

/** A catalogue entry by id, from the list given, else the snapshot. */
export function catalogModel(id: string, list: readonly CatalogModel[] = CATALOG_SNAPSHOT): CatalogModel | undefined {
  return list.find(model => model.id === id)
}

/** Gateway `/v1/models` entry → catalogue entry, or null for a model a chat cannot use (not a language model, no tools). */
export function parseGatewayModel(raw: unknown): CatalogModel | null {
  if (!raw || typeof raw !== 'object') return null
  const entry = raw as Record<string, unknown>
  const id = typeof entry.id === 'string' ? entry.id : ''
  const tags = Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === 'string') : []
  if (!isCatalogId(id) || entry.type !== 'language' || !tags.includes('tool-use') || id.endsWith('-batch')) return null
  const perMillion = (value: unknown) => {
    const n = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1e4) / 1e4 : undefined
  }
  const price = entry.pricing && typeof entry.pricing === 'object' ? entry.pricing as Record<string, unknown> : null
  const input = perMillion(price?.input), output = perMillion(price?.output), cacheRead = perMillion(price?.input_cache_read)
  const reasoning = Array.isArray(entry.reasoning_options)
    ? entry.reasoning_options.flatMap(option => option && typeof option === 'object' && Array.isArray((option as { values?: unknown }).values)
      ? ((option as { values: unknown[] }).values).filter((value): value is string => typeof value === 'string') : [])
    : []
  const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
  return {
    id, vendor: typeof entry.owned_by === 'string' ? entry.owned_by : id.split('/')[0],
    name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : cleanModelId(id),
    contextWindow: count(entry.context_window), maxTokens: count(entry.max_tokens),
    pricing: input === undefined || output === undefined ? null : { input, output, ...(cacheRead === undefined ? {} : { cacheRead }) },
    tags, reasoning,
  }
}
