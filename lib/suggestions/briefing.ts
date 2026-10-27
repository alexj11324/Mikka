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

/** The daily briefing is written at this local hour (R-21). */
export const BRIEFING_HOUR = 8

/** The local calendar date and hour at `now` in `timeZone`. */
export function localClock(timeZone: string, now: Date = new Date()): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: safeTimeZone(timeZone), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  const part = (type: string) => parts.find(item => item.type === type)?.value ?? ''
  return { date: `${part('year')}-${part('month')}-${part('day')}`, hour: Number(part('hour')) }
}

function offsetMs(timeZone: string, at: number) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(new Date(at))
  const part = (type: string) => Number(parts.find(item => item.type === type)?.value)
  return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second')) - Math.floor(at / 1000) * 1000
}

/** The instant `hour`:00 falls on `date` (YYYY-MM-DD) in `timeZone`. */
export function localInstant(timeZone: string, date: string, hour: number): Date {
  const zone = safeTimeZone(timeZone)
  const [year, month, day] = date.split('-').map(Number)
  const wall = Date.UTC(year, month - 1, day, hour)
  // Correct twice so a DST change between the guess and the answer is taken into account.
  const first = wall - offsetMs(zone, wall)
  return new Date(wall - offsetMs(zone, first))
}

/** For each time zone already past BRIEFING_HOUR today: its local date and when that day's briefing came due. */
export function dueBriefingZones(timeZones: readonly string[], now: Date = new Date()) {
  return timeZones.flatMap(timeZone => {
    const { date, hour } = localClock(timeZone, now)
    return hour >= BRIEFING_HOUR ? [{ timeZone, localDate: date, dueAt: localInstant(timeZone, date, BRIEFING_HOUR) }] : []
  })
}
