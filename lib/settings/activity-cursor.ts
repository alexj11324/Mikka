import { z } from 'zod'

/**
 * Activity paging. Items are ordered by (at DESC, id DESC in "C" collation);
 * the cursor is the last item's exact position. `at` is carried as integer
 * microseconds since the epoch, Postgres's own precision, so ties and
 * sub-millisecond neighbours are never skipped or repeated.
 */
export const ACTIVITY_FILTERS = ['all', 'accounts', 'reminders'] as const
export type ActivityFilter = (typeof ACTIVITY_FILTERS)[number]
export const ACTIVITY_PAGE_DEFAULT = 30
export const ACTIVITY_PAGE_MAX = 100

export interface ActivityPosition {
  /** Microseconds since the Unix epoch, as a decimal string. */
  micros: string
  id: string
}

const positionSchema = z.object({
  micros: z.string().regex(/^-?\d{1,19}$/),
  id: z.string().regex(/^(credential|action|reminder):[A-Za-z0-9-]{1,64}$/),
}).strict()

export function encodeActivityCursor(position: ActivityPosition): string {
  return Buffer.from(JSON.stringify({ micros: position.micros, id: position.id })).toString('base64url')
}

/** Null when the cursor is not one this server produced. */
export function decodeActivityCursor(cursor: string): ActivityPosition | null {
  if (cursor.length > 200 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null
  try {
    const parsed = positionSchema.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
    return parsed.success ? parsed.data : null
  } catch { return null }
}

const inputSchema = z.object({
  filter: z.enum(ACTIVITY_FILTERS).default('all'),
  cursor: z.string().nullish(),
  limit: z.number().int().min(1).max(ACTIVITY_PAGE_MAX).default(ACTIVITY_PAGE_DEFAULT),
}).strict()

export interface ActivityQuery {
  filter: ActivityFilter
  after: ActivityPosition | null
  limit: number
}

/** Null for anything malformed, including a cursor this server did not issue. */
export function parseActivityInput(input: unknown): ActivityQuery | null {
  const parsed = inputSchema.safeParse(input ?? {})
  if (!parsed.success) return null
  const after = parsed.data.cursor ? decodeActivityCursor(parsed.data.cursor) : null
  if (parsed.data.cursor && !after) return null
  return { filter: parsed.data.filter, after, limit: parsed.data.limit }
}

export const activitySources = (filter: ActivityFilter) => ({
  credentials: filter !== 'reminders',
  actions: filter !== 'reminders',
  reminders: filter !== 'accounts',
})
