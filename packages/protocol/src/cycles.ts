// A team's cycle rules and the date arithmetic behind them (ADR ORV-6).
//
// Both sides of the wire need this: the server's rollover job decides which
// cycles to create and what "today" means for a team, and the desktop app
// draws the same rules as a form. Keeping the arithmetic here means the two
// cannot drift, and it is pure, so the awkward days — a month end, a DST
// switch, the last minute of a cycle — are unit-testable without a database.
import { z } from "zod"

/**
 * A cycle starts on this weekday. Names, not numbers: the stored value is read
 * by people looking at a row, and 0 could be Sunday or Monday.
 */
export const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const
export type Weekday = (typeof WEEKDAYS)[number]

/** A cycle shorter than a day is not a time box; 8 weeks is Linear's ceiling. */
export const CYCLE_DURATION_MIN_DAYS = 1
export const CYCLE_DURATION_MAX_DAYS = 56
/** How many cycles a team may keep ready ahead of the current one. */
export const CYCLE_UPCOMING_MAX = 8

/**
 * How many cycles one rollover pass may create for a single team. A team whose
 * last cycle ended a year ago with one-day cycles would otherwise be handed
 * hundreds of rows in one transaction; the rest wait for the next pass.
 */
export const CYCLE_CATCH_UP_MAX = 24

/**
 * A team's cycle rules (`team_cycle_settings`). Every field has a default, so
 * a team that has never opened the page reads as "cycles off" without a row.
 */
export const teamCycleSettingsSchema = z.object({
  /** Off until a person turns it on: nothing is created and nothing rolls. */
  enabled: z.boolean().default(false),
  /** Length of a cycle in days; the end date is `start + duration - 1`. */
  durationDays: z
    .number()
    .int()
    .min(CYCLE_DURATION_MIN_DAYS)
    .max(CYCLE_DURATION_MAX_DAYS)
    .default(14),
  /** The weekday a team's first cycle starts on. */
  startWeekday: z.enum(WEEKDAYS).default("monday"),
  /** Cycles kept ready ahead of the current one. 0 creates them just in time. */
  upcomingCount: z.number().int().min(0).max(CYCLE_UPCOMING_MAX).default(1),
  /**
   * When a cycle ends, unfinished issues move to the next one. Off leaves them
   * in the finished cycle, which is what `cycle.complete` has always done.
   */
  autoRollover: z.boolean().default(true),
  /**
   * The team's calendar. A cycle ends at the last moment of its end date
   * *here*, not in UTC, so a team in Auckland and one in Los Angeles roll over
   * at different instants.
   */
  timezone: z
    .string()
    .max(64)
    .refine(isValidTimeZone, "Unknown timezone.")
    .default("UTC"),
})
export type TeamCycleSettings = z.infer<typeof teamCycleSettingsSchema>
export type StoredTeamCycleSettings = z.input<typeof teamCycleSettingsSchema>

/** Settings with defaults; unknown or invalid stored values fall back. */
export function teamCycleSettings(stored: unknown): TeamCycleSettings {
  const parsed = teamCycleSettingsSchema.safeParse(stored ?? {})
  return parsed.success ? parsed.data : teamCycleSettingsSchema.parse({})
}

/** A cycle's dates, the only part the schedule arithmetic cares about. */
export interface CycleWindow {
  number: number
  /** `YYYY-MM-DD`, inclusive. */
  startsAt: string
  /** `YYYY-MM-DD`, inclusive. */
  endsAt: string
}

const DAY_MS = 86_400_000

/**
 * A `YYYY-MM-DD` is a calendar day, not an instant, so it is parsed as UTC
 * midnight and every step below stays in UTC. Nothing here can be moved by a
 * daylight-saving switch; only `dateInTimeZone` and `endOfDayInTimeZone` know
 * about zones.
 */
function utcMidnight(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`)
}

export function addDays(iso: string, days: number): string {
  return new Date(utcMidnight(iso) + days * DAY_MS).toISOString().slice(0, 10)
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayOf(iso: string): number {
  return (new Date(utcMidnight(iso)).getUTCDay() + 6) % 7
}

/** `iso` itself when it already falls on `weekday`. */
export function nextWeekdayOnOrAfter(iso: string, weekday: Weekday): string {
  const delta = (WEEKDAYS.indexOf(weekday) - weekdayOf(iso) + 7) % 7
  return addDays(iso, delta)
}

/** The last day of a cycle that starts on `startsAt`; the end is inclusive. */
export function cycleEnd(startsAt: string, durationDays: number): string {
  return addDays(startsAt, durationDays - 1)
}

/**
 * The calendar day it is for a team. A cycle ending on the 8th is still the
 * current one at 23:59 on the 8th in the team's zone, wherever UTC is by then.
 */
export function dateInTimeZone(now: Date, timeZone: string): string {
  return localDay(now.getTime(), timeZone)
}

/** The calendar day `at` falls on for a team, as `YYYY-MM-DD`. */
function localDay(at: number, timeZone: string): string {
  const parts = dateFormatter(timeZone).formatToParts(new Date(at))
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ""
  return `${value("year")}-${value("month")}-${value("day")}`
}

/**
 * The instant a calendar day ends for a team: the last millisecond of `iso`
 * *there*. A completion recorded at 17:00 in Los Angeles happened on that day
 * even though UTC has already rolled over, so anything that buckets days has
 * to use this rather than UTC's midnight.
 *
 * Bisected on the local date rather than computed as "UTC midnight minus the
 * zone's offset". The two agree on an ordinary day, and disagree by an hour on
 * the days a zone springs forward *at* local midnight (America/Santiago,
 * America/Havana, Atlantic/Azores): that day has no local midnight at all —
 * the clock goes 23:59:59 → 01:00:00 — so the offset that applies *after* the
 * jump is the wrong one to subtract, and the day would end an hour early.
 * The local date never goes backwards however the offset moves, which is what
 * makes it safe to bisect; it also does the right thing for a zone that skips
 * a whole day (Pacific/Apia, 2011-12-30).
 */
export function endOfDayInTimeZone(iso: string, timeZone: string): number {
  const next = addDays(iso, 1)
  const anchor = Date.parse(`${next}T00:00:00Z`)
  // A day either side of the anchor brackets every offset in use (-12…+14),
  // so `low` is still on `iso` and `high` has already reached `next`.
  let low = anchor - DAY_MS
  let high = anchor + DAY_MS
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2)
    if (localDay(middle, timeZone) < next) low = middle
    else high = middle
  }
  return high - 1
}

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value })
    return true
  } catch {
    return false
  }
}

// Building a formatter is the expensive part, and the job asks for the same
// zone once per team per pass.
const formatters = new Map<string, Intl.DateTimeFormat>()

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone)
  if (cached) return cached
  const made = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  formatters.set(timeZone, made)
  return made
}

/**
 * The cycles a team should have that it does not, oldest first, numbered after
 * `existing`. Empty when cycles are off or the team is already up to date, so
 * running it twice in a row creates nothing the second time.
 *
 * Three things happen, in order: a team that just turned cycles on gets its
 * first window on its start weekday; every window that has already ended gets
 * its successor until the chain reaches today; and `upcomingCount` windows
 * that have not started yet are kept ready.
 */
export function planCycles(
  existing: readonly CycleWindow[],
  settings: TeamCycleSettings,
  today: string
): CycleWindow[] {
  if (!settings.enabled) return []

  const sorted = [...existing].sort((a, b) =>
    a.startsAt.localeCompare(b.startsAt)
  )
  const created: CycleWindow[] = []
  let last: CycleWindow | null = sorted.at(-1) ?? null

  if (!last) {
    const startsAt = nextWeekdayOnOrAfter(today, settings.startWeekday)
    last = {
      number: 0,
      startsAt,
      endsAt: cycleEnd(startsAt, settings.durationDays),
    }
    created.push(last)
  }

  // Catch up: a cycle that has ended needs its successor, and a team that was
  // away for a while may need several before one of them contains today.
  while (last.endsAt < today && created.length < CYCLE_CATCH_UP_MAX) {
    last = successor(last, settings.durationDays)
    created.push(last)
  }

  // Keep the requested number of cycles that have not started yet. A window
  // already in `existing` counts, so a team that plans ahead by hand is left
  // alone.
  let upcoming =
    created.filter((window) => window.startsAt > today).length +
    sorted.filter((window) => window.startsAt > today).length
  while (
    upcoming < settings.upcomingCount &&
    created.length < CYCLE_CATCH_UP_MAX
  ) {
    last = successor(last, settings.durationDays)
    created.push(last)
    upcoming += 1
  }

  // The number continues the team's *highest* one, not the number of the
  // latest-dated cycle: `cycle.create` hands out `max + 1` too, so a cycle a
  // person dated earlier than the others already holds a higher number.
  // Numbering from the latest date would hand out one that is taken, and the
  // insert would be dropped as a conflict — forever, on every pass.
  const nextNumber =
    sorted.reduce((highest, w) => Math.max(highest, w.number), 0) + 1
  return created.map((window, index) => ({
    ...window,
    number: nextNumber + index,
  }))
}

function successor(previous: CycleWindow, durationDays: number): CycleWindow {
  const startsAt = addDays(previous.endsAt, 1)
  return {
    number: previous.number + 1,
    startsAt,
    endsAt: cycleEnd(startsAt, durationDays),
  }
}
