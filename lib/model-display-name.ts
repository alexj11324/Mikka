/**
 * A model's display name from the id a provider, CLI or key reports
 * (Alex, 2026-11-06): `claude-fable-5-1-20261015` reads 「Fable 5.1」,
 * `anthropic/claude-opus-5-5` 「Opus 5.5」, `gpt-6-luna` 「GPT-6 Luna」,
 * `deepseek-v4.1-flash` 「DeepSeek V4.1 Flash」.
 *
 * Pure and stable: the hosted overlay's model picker uses it too. The raw id
 * stays the identity everywhere; this only names it. An id it does not
 * recognise comes back cleaned (no provider prefix, no date suffix), never guessed.
 */
export interface ModelDisplayName {
  /** What a person reads: 「Opus 5.5」. */
  name: string
  /** The series it belongs to (「Opus」, 「GPT」, 「DeepSeek」), or null when unrecognised. */
  family: string | null
  /** Its version with dots (「5.5」, 「V4.1」), or null. */
  version: string | null
  /** Who makes it, for a picker grouped by vendor; `other` when neither the id nor its prefix says. */
  vendor: ModelVendor
}

export const MODEL_VENDORS = ['anthropic', 'openai', 'google', 'deepseek', 'moonshot', 'alibaba', 'zhipu', 'mistral', 'meta', 'xai', 'other'] as const
export type ModelVendor = typeof MODEL_VENDORS[number]

/** A vendor from an id's own name (claude-…, gpt-…) or the prefix a gateway puts before it (anthropic/…). */
const VENDOR_PATTERNS: [RegExp, ModelVendor][] = [
  [/^(?:anthropic|claude)(?![a-z])|^(?:fable|opus|sonnet|haiku)$/, 'anthropic'],
  [/^(?:openai|gpt|chatgpt|o\d)(?![a-z])|^codex(?![a-z])/, 'openai'],
  [/^(?:google|gemini|gemma)(?![a-z])/, 'google'],
  [/^deepseek(?![a-z])/, 'deepseek'],
  [/^(?:moonshot(?:ai)?|kimi)(?![a-z])/, 'moonshot'],
  [/^(?:alibaba|qwen|qwq)(?![a-z])/, 'alibaba'],
  [/^(?:zhipu(?:ai)?|z-ai|glm)(?![a-z])/, 'zhipu'],
  [/^(?:mistral(?:ai)?|codestral|devstral|magistral)(?![a-z])/, 'mistral'],
  [/^(?:meta(?:-llama)?|llama)(?![a-z])/, 'meta'],
  [/^(?:x-ai|xai|grok)(?![a-z])/, 'xai'],
]

/** Who makes a model: its id first, then any gateway prefix (`openrouter/anthropic/…`); `other` when none says. */
export function modelVendor(id: string): ModelVendor {
  const parts = id.trim().toLowerCase().split('/').filter(Boolean).reverse()
  for (const part of parts) for (const [pattern, vendor] of VENDOR_PATTERNS) if (pattern.test(part)) return vendor
  return 'other'
}

const CLAUDE_FAMILIES: Record<string, string> = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' }
/** Display order of the series a picker groups by; any other family follows, then unrecognised ids. */
export const MODEL_FAMILY_ORDER = ['Fable', 'Opus', 'Sonnet', 'Haiku', 'GPT', 'DeepSeek'] as const

const word = (part: string) => /^\d/.test(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)
const dotted = (version: string) => version.replace(/[-_]/g, '.')

/** The id without a provider prefix (`anthropic/`, `openai/`) or a release date (`-20261015`, `-2026-10-15`). */
export function cleanModelId(id: string): string {
  const last = id.trim().split('/').filter(Boolean).pop() ?? ''
  return last.replace(/[-_@](?:20\d{6}|20\d{2}-\d{2}-\d{2})$/, '')
}

export function modelDisplayName(id: string): ModelDisplayName {
  return { ...modelName(id), vendor: modelVendor(id) }
}

function modelName(id: string): Omit<ModelDisplayName, 'vendor'> {
  const clean = cleanModelId(id)
  const lower = clean.toLowerCase()

  // Claude: claude-opus-5-5, claude-fable-5-1, the older claude-3-5-sonnet, and the CLI's bare aliases.
  const alias = CLAUDE_FAMILIES[lower]
  if (alias) return { name: alias, family: alias, version: null }
  const claude = /^claude-(?:(fable|opus|sonnet|haiku)-(\d+(?:[-.]\d+)*)|(\d+(?:[-.]\d+)*)-(fable|opus|sonnet|haiku))(?:-([a-z][a-z0-9-]*))?$/.exec(lower)
  if (claude) {
    const family = CLAUDE_FAMILIES[claude[1] ?? claude[4]]
    const version = dotted(claude[2] ?? claude[3])
    const rest = claude[5] ? ` ${claude[5].split('-').map(word).join(' ')}` : ''
    return { name: `${family} ${version}${rest}`, family, version }
  }

  // GPT: gpt-6-luna, gpt-5.6-mini, gpt-5-6-codex.
  const gpt = /^gpt-(\d+(?:[.-]\d+)*?)(?:-([a-z][a-z0-9-]*))?$/.exec(lower)
  if (gpt) {
    const version = dotted(gpt[1])
    const rest = gpt[2] ? ` ${gpt[2].split('-').map(word).join(' ')}` : ''
    return { name: `GPT-${version}${rest}`, family: 'GPT', version }
  }

  // DeepSeek: deepseek-v4.1-flash, deepseek-r2, deepseek-chat, the `deepseek-flash` alias.
  const deepseek = /^deepseek-(v\d+(?:\.\d+)*|r\d+)?-?([a-z][a-z0-9-]*)?$/.exec(lower)
  if (deepseek && (deepseek[1] || deepseek[2])) {
    const version = deepseek[1] ? deepseek[1].toUpperCase() : null
    const rest = deepseek[2] ? deepseek[2].split('-').map(word).join(' ') : ''
    return { name: ['DeepSeek', version, rest].filter(Boolean).join(' '), family: 'DeepSeek', version }
  }

  return { name: clean || id.trim(), family: null, version: null }
}

/** Rank for grouping by series: known families in MODEL_FAMILY_ORDER, then others, then unrecognised ids. */
export function modelFamilyRank(id: string): number {
  const { family } = modelDisplayName(id)
  if (!family) return MODEL_FAMILY_ORDER.length + 1
  const at = (MODEL_FAMILY_ORDER as readonly string[]).indexOf(family)
  return at < 0 ? MODEL_FAMILY_ORDER.length : at
}

/** Groups by series, keeping the given order within each series (a stable sort). */
export function groupByModelFamily<T>(items: readonly T[], idOf: (item: T) => string): T[] {
  return items.map((item, at) => ({ item, at, rank: modelFamilyRank(idOf(item)) }))
    .sort((a, b) => a.rank - b.rank || a.at - b.at).map(({ item }) => item)
}
