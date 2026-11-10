// 审计日志 paging: (createdAt DESC, id DESC). The cursor carries createdAt as
// integer microseconds (Postgres's precision) so ties are never skipped.
import { z } from 'zod'
import { AUDIT_CATEGORIES } from './categories'

export const AUDIT_FILTERS = ['all', 'security'] as const
export type AuditFilter = (typeof AUDIT_FILTERS)[number]
export const AUDIT_PAGE_DEFAULT = 50
export const AUDIT_PAGE_MAX = 100
/** N6 shows the last 90 days. */
export const AUDIT_WINDOW_DAYS = 90

export interface AuditPosition { micros: string; id: string }

const positionSchema = z.object({ micros: z.string().regex(/^\d{1,16}$/), id: z.uuid() }).strict()

export function encodeAuditCursor(position: AuditPosition): string {
  return Buffer.from(JSON.stringify({ micros: position.micros, id: position.id })).toString('base64url')
}

/** Null for anything this server did not produce. */
export function decodeAuditCursor(cursor: string): AuditPosition | null {
  if (cursor.length > 200 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null
  try {
    const parsed = positionSchema.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
    return parsed.success ? parsed.data : null
  } catch { return null }
}

const instant = z.iso.datetime({ offset: true })

/**
 * One page's input. `categories` narrows to those categories (with 「安全」 it
 * stays within security); `from` and `until` narrow the 90-day window, they
 * never widen it.
 */
export const auditPageInput = z.object({
  filter: z.enum(AUDIT_FILTERS).default('all'),
  categories: z.array(z.enum(AUDIT_CATEGORIES)).min(1).max(AUDIT_CATEGORIES.length).optional(),
  from: instant.optional(),
  until: instant.optional(),
  cursor: z.string().max(200).nullish(),
  limit: z.number().int().min(1).max(AUDIT_PAGE_MAX).default(AUDIT_PAGE_DEFAULT),
}).strict().refine(input => !input.from || !input.until || Date.parse(input.from) < Date.parse(input.until), { path: ['until'] })

/** The narrowing part of a page's input: what a read and its CSV export share. */
export type AuditScope = Pick<z.infer<typeof auditPageInput>, 'filter' | 'categories' | 'from' | 'until'>

/** The time window a scope reads: the last 90 days, narrowed by `from` and `until`. */
export function auditWindow(scope: Pick<AuditScope, 'from' | 'until'>, now: Date) {
  const floor = now.getTime() - AUDIT_WINDOW_DAYS * 86_400_000
  const since = new Date(Math.max(floor, scope.from ? Date.parse(scope.from) : floor))
  const until = new Date(Math.min(now.getTime(), scope.until ? Date.parse(scope.until) : now.getTime()))
  return { since, until }
}

/**
 * A scope from a URL's query (the settings read and the CSV export):
 * `filter`, `category` (comma-separated), `from`, `until`. Unknown values stay
 * as given, so the schema refuses them instead of reading everything.
 */
export function auditScopeQuery(search: URLSearchParams): Record<string, unknown> {
  const scope: Record<string, unknown> = {}
  for (const name of ['filter', 'from', 'until'] as const) {
    const value = search.get(name)
    if (value !== null) scope[name] = value
  }
  const category = search.get('category')
  if (category !== null) scope.categories = category.split(',')
  return scope
}

/** One CSV field: quoted when needed, and never read as a formula by a spreadsheet. */
export function csvField(value: string | null | undefined): string {
  let text = value ?? ''
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
