// 审计日志 paging: (createdAt DESC, id DESC). The cursor carries createdAt as
// integer microseconds (Postgres's precision) so ties are never skipped.
import { z } from 'zod'

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

export const auditPageInput = z.object({
  filter: z.enum(AUDIT_FILTERS).default('all'),
  cursor: z.string().max(200).nullish(),
  limit: z.number().int().min(1).max(AUDIT_PAGE_MAX).default(AUDIT_PAGE_DEFAULT),
}).strict()

/** One CSV field: quoted when needed, and never read as a formula by a spreadsheet. */
export function csvField(value: string | null | undefined): string {
  let text = value ?? ''
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
