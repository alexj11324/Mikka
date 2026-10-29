import 'server-only'
import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { pool } from '@/lib/db'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import {
  auditCategory, auditRetentionStart, decodeAuditCursor, encodeAuditCursor,
  type AuditAction, type AuditEventView, type AuditFilter,
} from './actions'

export interface AuditRequestContext {
  ip: string | null
  userAgent: string | null
  country: string | null
}

export interface AuditEventInput {
  workspaceId: string
  actorId: string | null
  action: AuditAction
  target?: string | null
  metadata?: Record<string, string | number | boolean | null>
  /** Defaults to the current request's headers; null outside a request. */
  request?: AuditRequestContext | null
}

type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }

const clip = (value: string | null | undefined, max: number) => value ? value.slice(0, max) : null

/** Reads ip / user agent / country from a request's headers (Vercel sets the country). */
export function auditContextFromHeaders(headers: Pick<Headers, 'get'>): AuditRequestContext {
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim() || headers.get('x-real-ip')
  const country = headers.get('x-vercel-ip-country')
  return {
    ip: clip(forwarded, 64),
    userAgent: clip(headers.get('user-agent'), 512),
    country: country && /^[A-Z]{2}$/.test(country) ? country : null,
  }
}

async function currentRequestContext(): Promise<AuditRequestContext | null> {
  try {
    const { headers } = await import('next/headers')
    return auditContextFromHeaders(await headers())
  } catch {
    return null // Outside a request (cron, workflow step, tests).
  }
}

/**
 * Appends one audit row. Callers write it after the change commits; pass
 * `executor` to write inside the same transaction instead.
 */
export async function recordAuditEvent(input: AuditEventInput, executor: Queryable = pool): Promise<void> {
  const request = input.request === undefined ? await currentRequestContext() : input.request
  await executor.query(
    `INSERT INTO audit_events (id, "workspaceId", "actorId", action, category, target, metadata, ip, "userAgent", country)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
    [randomUUID(), input.workspaceId, input.actorId, input.action, auditCategory(input.action), clip(input.target, 300),
      JSON.stringify(input.metadata ?? {}), request?.ip ?? null, request?.userAgent ?? null, request?.country ?? null],
  )
}

/**
 * A personal security change (2FA, passkey, token) is shown in the audit log
 * of every workspace the person is an active member of.
 */
export async function recordPersonalAuditEvent(actorId: string, action: AuditAction, target?: string | null, metadata?: AuditEventInput['metadata']): Promise<void> {
  const memberships = await workspaceDb.select({ workspaceId: workspaceMembers.workspaceId }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, actorId), eq(workspaceMembers.status, 'active')))
  const request = await currentRequestContext()
  for (const { workspaceId } of memberships) await recordAuditEvent({ workspaceId, actorId, action, target, metadata, request })
}

export interface AuditPage {
  events: AuditEventView[]
  nextCursor: string | null
}

export const AUDIT_PAGE_SIZE = 50
export const AUDIT_EXPORT_LIMIT = 10_000

/** Reads one page, newest first, within the 90-day window. Authorisation is the caller's. */
export async function readAuditEvents(input: { workspaceId: string; filter: AuditFilter; cursor?: string | null; limit?: number; now?: Date }, executor: Queryable = pool): Promise<AuditPage> {
  const limit = Math.min(Math.max(input.limit ?? AUDIT_PAGE_SIZE, 1), AUDIT_EXPORT_LIMIT)
  const values: unknown[] = [input.workspaceId, auditRetentionStart(input.now)]
  let where = `e."workspaceId" = $1 AND e."createdAt" >= $2`
  if (input.filter !== 'all') {
    values.push(input.filter)
    where += ` AND e.category = $${values.length}`
  }
  const cursor = input.cursor ? decodeAuditCursor(input.cursor) : null
  if (cursor) {
    values.push(cursor.createdAt, cursor.id)
    where += ` AND (e."createdAt", e.id) < ($${values.length - 1}, $${values.length}::uuid)`
  }
  values.push(limit + 1)
  const { rows } = await executor.query(
    `SELECT e.id, e.action, e.category, e."actorId", u.name AS "actorName", u.email AS "actorEmail", e.target, e.metadata,
            e.ip, e."userAgent", e.country, e."createdAt"
       FROM audit_events e LEFT JOIN "user" u ON u.id = e."actorId"
      WHERE ${where}
      ORDER BY e."createdAt" DESC, e.id DESC
      LIMIT $${values.length}`,
    values,
  )
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  return {
    events: page.map(row => ({
      id: row.id as string, action: row.action as string, category: row.category as AuditEventView['category'],
      actorId: (row.actorId as string | null) ?? null, actorName: (row.actorName as string | null) ?? null,
      actorEmail: (row.actorEmail as string | null) ?? null, target: (row.target as string | null) ?? null,
      metadata: (row.metadata as AuditEventView['metadata']) ?? {}, ip: (row.ip as string | null) ?? null,
      userAgent: (row.userAgent as string | null) ?? null, country: (row.country as string | null) ?? null,
      createdAt: (row.createdAt as Date).toISOString(),
    })),
    nextCursor: rows.length > limit && last ? encodeAuditCursor({ createdAt: last.createdAt as Date, id: last.id as string }) : null,
  }
}

/** Deletes rows past the retention window; returns how many were removed. */
export async function deleteExpiredAuditEvents(now = new Date(), executor: Queryable = pool): Promise<number> {
  const { rows } = await executor.query(
    `WITH gone AS (DELETE FROM audit_events WHERE "createdAt" < $1 RETURNING 1) SELECT count(*)::int AS deleted FROM gone`,
    [auditRetentionStart(now)],
  )
  return Number(rows[0]?.deleted ?? 0)
}
