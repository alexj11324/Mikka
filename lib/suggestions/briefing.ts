import { levelRank, type AttentionLevel } from '@/lib/attention/judgment'
import type { SuggestionAction, SuggestionSource } from '@/lib/db/schema'

// The "早上好" briefing as data: which suggestions to name and how many each
// app brought. The UI (MIK-42) writes the sentence and renders the source
// chips, so the briefing carries no prose and follows the person's language.

/** How many suggestions a briefing names. */
export const HIGHLIGHT_LIMIT = 3
/** A daily briefing covers what arrived in this window before it. */
export const BRIEFING_WINDOW_MS = 24 * 60 * 60 * 1000

export interface BriefingItem { id: string; source: SuggestionSource; action: SuggestionAction; required: boolean; level: AttentionLevel | null; probability: number | null; occurredAt: Date }

/** Rows from before the attention levels rank by the old probability, as normal around it. */
function rank(item: BriefingItem): number {
  return item.level ? levelRank(item.level) : levelRank('normal') + ((item.probability ?? 0.5) - 0.5)
}

export interface BriefingContent { highlights: string[]; counts: Partial<Record<SuggestionSource, number>>; total: number }

/** The highest attention level first, then required items, then newest. */
export function rankForBriefing<T extends BriefingItem>(items: readonly T[]): T[] {
  return [...items].sort((a, b) =>
    rank(b) - rank(a)
    || Number(b.required) - Number(a.required)
    || b.occurredAt.getTime() - a.occurredAt.getTime())
}

export function briefingContent(items: readonly BriefingItem[]): BriefingContent {
  const counts: Partial<Record<SuggestionSource, number>> = {}
  for (const item of items) counts[item.source] = (counts[item.source] ?? 0) + 1
  return { highlights: rankForBriefing(items).slice(0, HIGHLIGHT_LIMIT).map(item => item.id), counts, total: items.length }
}

/** A valid IANA time zone name, or UTC. */
export function safeTimeZone(value: string | null | undefined): string {
  if (!value || value.length > 64) return 'UTC'
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return value
  } catch {
    return 'UTC'
  }
}

/** The calendar date (YYYY-MM-DD) at `now` in `timeZone`. */
export function localDate(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: safeTimeZone(timeZone), year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}
