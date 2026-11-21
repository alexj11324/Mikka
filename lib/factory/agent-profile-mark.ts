import { z } from 'zod'
import type { ThreadGroup } from '../thread-groups'

/**
 * An Agent Profile's own mark (Alex, 2026-11-10): a small dotted glyph that says
 * who does a stretch of work, while the Agent's brand mark says what runs it.
 * Shape tells Profiles apart; colour only assists. Both are closed sets so the
 * stored value is always one the UI can draw. Client-safe: no server imports.
 */
export const PROFILE_GLYPHS = ['square', 'chevrons', 'lens', 'lines', 'check', 'stairs', 'diamond', 'arrow'] as const
export type ProfileGlyph = (typeof PROFILE_GLYPHS)[number]
/**
 * Chromatic only (Alex, 2026-11-20): white and grey read as "not working". These may share a hue with a task
 * state, which is drawn with its own shapes; the dotted glyph is never read as a status.
 */
export const PROFILE_COLORS = ['blue', 'teal', 'emerald', 'violet', 'pink'] as const
export type ProfileColor = (typeof PROFILE_COLORS)[number]
export type ProfileMarkValue = { icon: ProfileGlyph; color: ProfileColor }

/**
 * The four visual states of a ProfileMark (Figma "Chat+右栏" section 21, #2932):
 * `working` animates in the Profile's own colour, `idle` is still in the same colour,
 * `needs-you` switches to warning (always paired with text), `failed` to destructive (always paired with text).
 */
export const PROFILE_MARK_STATES = ['working', 'idle', 'needs-you', 'failed'] as const
export type ProfileMarkState = (typeof PROFILE_MARK_STATES)[number]

const WORKING_STATUSES = new Set(['working', 'queued', 'preparing', 'running', 'finishing'])
const NEEDS_YOU_STATUSES = new Set(['waiting-on-you', 'waiting_on_you', 'waiting_input', 'waiting', 'needs-you', 'needs_you'])
const FAILED_STATUSES = new Set(['failed', 'error', 'blocked', 'paused'])

/** Shared status-to-ProfileMarkState mapping for sidebar rows, thread headers, task cards and sub-agent cards. */
export function profileMarkStateOf(input: {
  status?: string | null
  outcome?: string | null
  waiting?: boolean
  group?: ThreadGroup | null
}): ProfileMarkState {
  if (input.waiting) return 'needs-you'
  if (input.group) {
    if (input.group === 'running') return 'working'
    if (input.group === 'waiting') return 'needs-you'
    if (input.group === 'blocked') return 'failed'
    return 'idle'
  }
  const status = input.status?.trim().toLowerCase() ?? ''
  const outcome = input.outcome?.trim().toLowerCase() ?? ''
  if (WORKING_STATUSES.has(status)) return 'working'
  if (NEEDS_YOU_STATUSES.has(status) || outcome === 'needs_input') return 'needs-you'
  if (FAILED_STATUSES.has(status) || outcome === 'failed' || outcome === 'blocked') return 'failed'
  return 'idle'
}

/** `needs-you` and `failed` must always appear with adjacent state text, never colour alone (Figma 1346:5024). */
export const profileMarkStateRequiresText = (state: ProfileMarkState): boolean =>
  state === 'needs-you' || state === 'failed'

/** The built-in Default profile's fixed mark. */
export const DEFAULT_PROFILE_MARK: ProfileMarkValue = { icon: 'square', color: 'blue' }

export const profileGlyphSchema = z.enum(PROFILE_GLYPHS)
export const profileColorSchema = z.enum(PROFILE_COLORS)
/** What a save may send: a closed id, or null to fall back to the derived default. */
export const profileMarkInputSchema = z.strictObject({ icon: profileGlyphSchema.nullable().optional(), color: profileColorSchema.nullable().optional() })
export type ProfileMarkInput = z.infer<typeof profileMarkInputSchema>

const isGlyph = (value: unknown): value is ProfileGlyph => typeof value === 'string' && (PROFILE_GLYPHS as readonly string[]).includes(value)
const isColor = (value: unknown): value is ProfileColor => typeof value === 'string' && (PROFILE_COLORS as readonly string[]).includes(value)
/** Colours before 2026-11-20, still in frozen runs and admitted by the column during a deploy: each keeps a colour of its own. */
const LEGACY_COLORS: Readonly<Record<string, ProfileColor>> = { ink: 'blue', graphite: 'violet' }
export const storedProfileColor = (value: unknown): ProfileColor | undefined =>
  isColor(value) ? value : typeof value === 'string' ? LEGACY_COLORS[value] : undefined

/** Responsibility words, English and Chinese; on a tie of position the earlier entry wins. */
const GLYPH_WORDS: readonly [Exclude<ProfileGlyph, 'square'>, RegExp][] = [
  ['check', /\b(test|tests|testing|tester|verify|verifier|verification|qa|validat\w*|accept\w*)\b|测试|验证|验收|校验/i],
  ['lens', /\b(review|reviewer|audit\w*|research\w*|investigat\w*|inspect\w*)\b|审查|评审|审核|调研|研究|排查/i],
  ['lines', /\b(docs?|documentation|writ\w*|copy|changelog)\b|文档|写作|撰写|说明/i],
  ['stairs', /\b(plan\w*|spec\w*|architect\w*|triage)\b|规划|计划|方案|规格|架构|拆解/i],
  ['diamond', /\b(design\w*|ui|ux|frontend|front-end|visual)\b|设计|前端|界面|视觉/i],
  ['arrow', /\b(deploy\w*|release\w*|ops|devops|ship\w*|infra\w*|migrat\w*|monitor\w*)\b|发布|部署|运维|上线|迁移|监控/i],
  ['chevrons', /\b(implement\w*|build\w*|cod(e|er|ing)|develop\w*|engineer\w*|backend|fix\w*)\b|实现|开发|编码|编程|构建|修复|后端/i],
]
const HASHED_GLYPHS = PROFILE_GLYPHS.filter(glyph => glyph !== 'square')
/** Default colours leave the built-in Default's colour to it so a custom Profile reads apart from it. */
const HASHED_COLORS = PROFILE_COLORS.filter(color => color !== DEFAULT_PROFILE_MARK.color)

function hash(text: string) {
  let value = 0
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) | 0
  return Math.abs(value)
}

/**
 * The mark a Profile gets when none was chosen: a glyph from its roles, then its
 * name, then its description; otherwise one picked steadily from its name.
 * The colour is picked steadily from the name and glyph.
 */
export function deriveProfileMark(profile: { name: string; roles?: readonly string[]; description?: string }): ProfileMarkValue {
  const texts = [...(profile.roles ?? []), profile.name, profile.description ?? '']
  let icon: ProfileGlyph | undefined
  // Within one text the earliest responsibility word wins ("plans and writes specs" plans).
  for (const text of texts) {
    let first = Infinity
    for (const [glyph, words] of GLYPH_WORDS) {
      const at = text.search(words)
      if (at >= 0 && at < first) { first = at; icon = glyph }
    }
    if (icon) break
  }
  icon ??= HASHED_GLYPHS[hash(profile.name.trim().toLowerCase()) % HASHED_GLYPHS.length]
  const color = HASHED_COLORS[hash(icon + ':' + profile.name.trim().toLowerCase()) % HASHED_COLORS.length]
  return { icon, color }
}

/** A stored (or frozen) mark with any missing or unknown part filled from the derived default. */
export function resolveProfileMark(profile: { name: string; roles?: readonly string[]; description?: string }, stored?: { icon?: unknown; color?: unknown } | null): ProfileMarkValue {
  const icon = isGlyph(stored?.icon) ? stored.icon : undefined
  const color = storedProfileColor(stored?.color)
  if (icon && color) return { icon, color }
  const derived = deriveProfileMark(profile)
  return { icon: icon ?? derived.icon, color: color ?? derived.color }
}
