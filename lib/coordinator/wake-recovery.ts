import type { Pool } from 'pg'
import { botChatChanged } from '../live/chats'

export const MAX_WAKE_ATTEMPTS = 8
export const WAKE_LEASE_MS = 120_000
export const WAKE_BACKOFF_MS = [60_000, 120_000, 240_000, 480_000, 900_000] as const
export type WakeScope = { userId: string; botId: string }
export type WakeClaim = WakeScope & { ids: string[]; leaseUntil: Date; attempt: number }
export type WakeEventVersion = { id: string; attempt: number; nextWakeAt: string; leaseUntil: string | null }
/** Host scheduling metadata only. An old timer may act only on these exact row versions. */
export type WakeDeadlineTicket = WakeScope & { at: string; events: WakeEventVersion[] }
export type DeadlineWakeClaim = WakeClaim & { ticket: WakeDeadlineTicket | null }
export type WakeDeadlineResult = { kind: 'claimed'; claim: DeadlineWakeClaim } | { kind: 'wait'; at: string } | { kind: 'obsolete' }
type WakeRow = { id: string; wakeAttempts: number; nextWakeAt: Date; wakeLeaseUntil: Date | null; tier: string | null }

function deadline(rows: readonly WakeRow[]): number {
  return Math.min(...rows.map(row => Math.max(row.nextWakeAt.getTime(), row.wakeLeaseUntil?.getTime() ?? 0)))
}

function ticketFor(scope: WakeScope, rows: readonly WakeRow[]): WakeDeadlineTicket | null {
  const pending = rows.filter(row => row.wakeAttempts < MAX_WAKE_ATTEMPTS && row.tier !== 'background')
  return pending.length ? { userId: scope.userId, botId: scope.botId, at: new Date(deadline(pending)).toISOString(), events: pending.map(row => ({
    id: row.id, attempt: row.wakeAttempts, nextWakeAt: row.nextWakeAt.toISOString(), leaseUntil: row.wakeLeaseUntil?.toISOString() ?? null,
  })) } : null
}

const exactDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
function validTicket(scope: WakeScope, ticket: WakeDeadlineTicket): boolean {
  if (ticket.userId !== scope.userId || ticket.botId !== scope.botId || !exactDate(ticket.at) || !Array.isArray(ticket.events)
    || !ticket.events.length || ticket.events.length > 50 || new Set(ticket.events.map(event => event.id)).size !== ticket.events.length) return false
  return ticket.events.every(event => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(event.id) && Number.isSafeInteger(event.attempt) && event.attempt > 0 && event.attempt < MAX_WAKE_ATTEMPTS
    && exactDate(event.nextWakeAt) && (event.leaseUntil === null || exactDate(event.leaseUntil)))
}

const matchesTicket = (parameter: number) => `AND EXISTS (
  SELECT 1 FROM jsonb_to_recordset($${parameter}::jsonb) AS expected(id uuid,attempt integer,"nextWakeAt" timestamptz,"leaseUntil" timestamptz)
  WHERE expected.id=e.id AND expected.attempt=e."wakeAttempts" AND expected."nextWakeAt"=e."nextWakeAt"
    AND expected."leaseUntil" IS NOT DISTINCT FROM e."wakeLeaseUntil")`

/** A committed inbox row is enough to recover even if the producer dies
 * before calling wakeCoordinator. No process timer or in-memory queue owns it. */
export function createWakeRecovery(pool: Pick<Pool, 'connect' | 'query'>, clock: () => Date = () => new Date()) {
  const pending = `e."deliveredAt" IS NULL AND (e.tier IS NULL OR e.tier <> 'background') AND e."wakeAttempts" < ${MAX_WAKE_ATTEMPTS}`
  async function take(scope: WakeScope, ticket?: WakeDeadlineTicket): Promise<WakeDeadlineResult> {
    if (ticket && !validTicket(scope, ticket)) return { kind: 'obsolete' }
    const tx = await pool.connect()
    const now = clock(), leaseUntil = new Date(now.getTime() + WAKE_LEASE_MS)
    const versions = ticket ? JSON.stringify(ticket.events) : undefined
    try {
      await tx.query('BEGIN')
      await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [JSON.stringify(['coordinator-wake', scope.userId, scope.botId])])
      let nextAt = now.getTime()
      if (ticket) {
        const current = (await tx.query<WakeRow>(`SELECT e.id,e."wakeAttempts",e."nextWakeAt",e."wakeLeaseUntil",e.tier
          FROM coordinator_events e WHERE e."userId"=$1 AND e."botId"=$2::uuid AND ${pending} ${matchesTicket(3)}`,
        [scope.userId, scope.botId, versions])).rows
        if (!current.length) { await tx.query('COMMIT'); return { kind: 'obsolete' } }
        nextAt = deadline(current)
      }
      // pg's Date parser drops PostgreSQL microseconds. Round up in SQL so a
      // lease that SQL still considers live cannot disappear at this boundary.
      const held = await tx.query<{ untilMs: string | null }>(`SELECT ceil(extract(epoch FROM max("until"))*1000)::bigint::text AS "untilMs" FROM (
        SELECT "wakeLeaseUntil" AS "until" FROM coordinator_events WHERE "userId"=$1 AND "botId"=$2::uuid
          AND "deliveredAt" IS NULL AND "wakeLeaseUntil">$3
        UNION ALL SELECT "leaseUntil" FROM coordinator_sessions WHERE "userId"=$1 AND "botId"=$2::uuid
          AND "leaseHolder" IS NOT NULL AND "leaseUntil">$3) held`, [scope.userId, scope.botId, now])
      nextAt = Math.max(nextAt, Number(held.rows[0]?.untilMs ?? 0))
      if (nextAt > now.getTime()) { await tx.query('COMMIT'); return { kind: 'wait', at: new Date(nextAt).toISOString() } }
      const values = [scope.userId, scope.botId, now, leaseUntil, ...(ticket ? [versions] : [])]
      const rows = (await tx.query<WakeRow>(`UPDATE coordinator_events AS target SET
        "wakeAttempts"=target."wakeAttempts"+1,"wakeLeaseUntil"=$4,"nextWakeAt"=$4,
        "wakeLastError"=CASE WHEN target."wakeAttempts"+1 >= ${MAX_WAKE_ATTEMPTS} THEN 'wake_exhausted' ELSE NULL END
        WHERE target.id IN (SELECT e.id FROM coordinator_events e WHERE e."userId"=$1 AND e."botId"=$2::uuid
          AND ${pending} AND e."nextWakeAt" <= $3 ${ticket ? matchesTicket(5) : ''} ORDER BY e."createdAt",e.id LIMIT 50 FOR UPDATE)
        RETURNING target.id,target."wakeAttempts",target."nextWakeAt",target."wakeLeaseUntil",target.tier`, values)).rows
      if (rows.length) await botChatChanged(tx, scope.userId, scope.botId)
      await tx.query('COMMIT')
      return rows.length ? { kind: 'claimed', claim: { userId: scope.userId, botId: scope.botId, ids: rows.map(row => row.id), leaseUntil,
        attempt: Math.max(...rows.map(row => row.wakeAttempts)), ticket: ticketFor(scope, rows) } } : { kind: 'obsolete' }
    } catch (error) {
      await tx.query('ROLLBACK')
      throw error
    } finally { tx.release() }
  }
  return {
    /** A null botId is an event written before the Coordinator had its bot row; the sweep moves it there first. */
    async due(limit = 50): Promise<{ userId: string; botId: string | null }[]> {
      return (await pool.query<{ userId: string; botId: string | null }>(`SELECT "userId", "botId" FROM coordinator_events e
        WHERE ${pending} AND "nextWakeAt" <= $1 AND ("wakeLeaseUntil" IS NULL OR "wakeLeaseUntil" <= $1)
        GROUP BY "userId", "botId" ORDER BY min("nextWakeAt") LIMIT $2`, [clock(), limit])).rows
    },
    async exhausted(): Promise<number> {
      const result = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM coordinator_events
        WHERE "deliveredAt" IS NULL AND (tier IS NULL OR tier <> 'background') AND "wakeAttempts">=$1`, [MAX_WAKE_ATTEMPTS])
      return Number(result.rows[0]?.count ?? 0)
    },
    async claim(scope: WakeScope, ticket?: WakeDeadlineTicket): Promise<DeadlineWakeClaim | null> {
      const result = await take(scope, ticket)
      return result.kind === 'claimed' ? result.claim : null
    },
    /** A timer cannot turn into an unrestricted scope wake after its original work changes. */
    resume(ticket: WakeDeadlineTicket): Promise<WakeDeadlineResult> { return take(ticket, ticket) },
    async failed(claim: WakeClaim, code: 'wake_failed' | 'triage_pending'): Promise<WakeDeadlineTicket | null> {
      const tx = await pool.connect()
      const next = new Date(clock().getTime() + WAKE_BACKOFF_MS[Math.min(claim.attempt - 1, WAKE_BACKOFF_MS.length - 1)])
      try {
        await tx.query('BEGIN')
        const rows = await tx.query<WakeRow>(`UPDATE coordinator_events SET "wakeLeaseUntil"=NULL,"nextWakeAt"=$4,"wakeLastError"=$5
          WHERE "userId"=$1 AND id=ANY($2::uuid[]) AND "wakeLeaseUntil"=$3 AND "deliveredAt" IS NULL AND "botId"=$6::uuid
          RETURNING id,"wakeAttempts","nextWakeAt","wakeLeaseUntil",tier`,
        [claim.userId, claim.ids, claim.leaseUntil, next, claim.attempt >= MAX_WAKE_ATTEMPTS ? 'wake_exhausted' : code, claim.botId])
        if (rows.rowCount) await botChatChanged(tx, claim.userId, claim.botId)
        await tx.query('COMMIT')
        return ticketFor(claim, rows.rows)
      } catch (error) {
        await tx.query('ROLLBACK')
        throw error
      } finally { tx.release() }
    },
    /** Operator-triggered replay resets only a still-pending event. It does
     * not restore cancelled runs, revoked access, or already-consumed events. */
    async replay(id: string): Promise<boolean> {
      const result = await pool.query<{ userId: string; botId: string | null }>(`UPDATE coordinator_events SET "wakeAttempts"=0,"nextWakeAt"=$2,"wakeLastError"=NULL
        WHERE id=$1 AND "deliveredAt" IS NULL AND "wakeAttempts">= $3
        AND ("wakeLeaseUntil" IS NULL OR "wakeLeaseUntil" <= $2) RETURNING "userId","botId"`, [id, clock(), MAX_WAKE_ATTEMPTS])
      if (result.rows[0]) await botChatChanged(pool, result.rows[0].userId, result.rows[0].botId)
      return Boolean(result.rowCount)
    },
  }
}

/** Delivery errors become persisted retries; provider/error text is never
 * stored in the inbox. A successful start keeps its short recovery lease. */
export async function deliverWake(claim: WakeClaim, deps: {
  triage(scope: WakeScope): Promise<void>
  hasWaking(scope: WakeScope): Promise<boolean>
  start(scope: WakeScope): Promise<void>
  failed(claim: WakeClaim, code: 'wake_failed' | 'triage_pending'): Promise<unknown>
  /** The last attempt did not start a turn: nothing will run to tell the person, so this does. Its failure never changes the outcome. */
  exhausted?(claim: WakeClaim): Promise<void>
}): Promise<'started' | 'deferred' | 'failed'> {
  const outcome = await attempt(claim, deps)
  if (outcome !== 'started' && claim.attempt >= MAX_WAKE_ATTEMPTS && deps.exhausted) await deps.exhausted(claim).catch(() => undefined)
  return outcome
}

async function attempt(claim: WakeClaim, deps: Parameters<typeof deliverWake>[1]): Promise<'started' | 'deferred' | 'failed'> {
  try {
    await deps.triage(claim)
    if (!await deps.hasWaking(claim)) {
      await deps.failed(claim, 'triage_pending')
      return 'deferred'
    }
    await deps.start(claim)
    return 'started'
  } catch {
    await deps.failed(claim, 'wake_failed')
    return 'failed'
  }
}
