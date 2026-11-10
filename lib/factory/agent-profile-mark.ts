import { z } from 'zod'

/**
 * An Agent Profile's own mark (Alex, 2026-11-10): a small dotted glyph that says
 * who does a stretch of work, while the Agent's brand mark says what runs it.
 * Shape tells Profiles apart; colour only assists. Both are closed sets so the
 * stored value is always one the UI can draw. Client-safe: no server imports.
 */
export const PROFILE_GLYPHS = ['square', 'chevrons', 'lens', 'lines', 'check', 'stairs', 'diamond', 'arrow'] as const
export type ProfileGlyph = (typeof PROFILE_GLYPHS)[number]
/** Ink and grey, then hues no task state or Agent brand mark uses (no amber, red, green, blue or the info/waiting violet). */
export const PROFILE_COLORS = ['ink', 'graphite', 'teal', 'pink'] as const
export type ProfileColor = (typeof PROFILE_COLORS)[number]
export type ProfileMarkValue = { icon: ProfileGlyph; color: ProfileColor }

/** The built-in Default profile's fixed mark. */
export const DEFAULT_PROFILE_MARK: ProfileMarkValue = { icon: 'square', color: 'ink' }

export const profileGlyphSchema = z.enum(PROFILE_GLYPHS)
export const profileColorSchema = z.enum(PROFILE_COLORS)
/** What a save may send: a closed id, or null to fall back to the derived default. */
export const profileMarkInputSchema = z.strictObject({ icon: profileGlyphSchema.nullable().optional(), color: profileColorSchema.nullable().optional() })
export type ProfileMarkInput = z.infer<typeof profileMarkInputSchema>

const isGlyph = (value: unknown): value is ProfileGlyph => typeof value === 'string' && (PROFILE_GLYPHS as readonly string[]).includes(value)
const isColor = (value: unknown): value is ProfileColor => typeof value === 'string' && (PROFILE_COLORS as readonly string[]).includes(value)

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
/** Default colours leave ink to the built-in Default so a custom Profile reads apart from it. */
const HASHED_COLORS = PROFILE_COLORS.filter(color => color !== 'ink')

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
  const color = isColor(stored?.color) ? stored.color : undefined
  if (icon && color) return { icon, color }
  const derived = deriveProfileMark(profile)
  return { icon: icon ?? derived.icon, color: color ?? derived.color }
}
