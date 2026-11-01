import type { Pool } from 'pg'

export const MAX_WAKE_ATTEMPTS = 8
export const WAKE_LEASE_MS = 120_000
export const WAKE_BACKOFF_MS = [60_000, 120_000, 240_000, 480_000, 900_000] as const
export type WakeScope = { userId: string; botId: string | null }
export type WakeClaim = WakeScope & { ids: string[]; leaseUntil: Date; attempt: number }

/** A committed inbox row is enough to recover even if the producer dies
 * before calling wakeCoordinator. No process timer or in-memory queue owns it. */
export function createWakeRecovery(pool: Pick<Pool, 'connect' | 'query'>, clock: () => Date = () => new Date()) {
  const pending = `"deliveredAt" IS NULL AND (tier IS NULL OR tier <> 'background') AND "wakeAttempts" < ${MAX_WAKE_ATTEMPTS}`
  return {
    async due(limit = 50): Promise<WakeScope[]> {
      return (await pool.query<WakeScope>(`SELECT "userId", "botId" FROM coordinator_events
        WHERE ${pending} AND "nextWakeAt" <= $1 AND ("wakeLeaseUntil" IS NULL OR "wakeLeaseUntil" <= $1)
        GROUP BY "userId", "botId" ORDER BY min("nextWakeAt") LIMIT $2`, [clock(), limit])).rows
    },
    async exhausted(): Promise<number> {
      const result = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM coordinator_events
        WHERE "deliveredAt" IS NULL AND (tier IS NULL OR tier <> 'background') AND "wakeAttempts">=$1`, [MAX_WAKE_ATTEMPTS])
      return Number(result.rows[0]?.count ?? 0)
    },
    async claim(scope: WakeScope): Promise<WakeClaim | null> {
      const tx = await pool.connect()
      const now = clock(), leaseUntil = new Date(now.getTime() + WAKE_LEASE_MS)
      try {
        await tx.query('BEGIN')
        await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [JSON.stringify(['coordinator-wake', scope.userId, scope.botId])])
        const held = await tx.query(`SELECT 1 FROM coordinator_events WHERE "userId"=$1 AND "botId" IS NOT DISTINCT FROM $2::uuid
          AND "deliveredAt" IS NULL AND "wakeLeaseUntil">$3
          UNION ALL SELECT 1 FROM coordinator_sessions WHERE "userId"=$1 AND "botId" IS NOT DISTINCT FROM $2::uuid
          AND "leaseHolder" IS NOT NULL AND "leaseUntil">$3 LIMIT 1`, [scope.userId, scope.botId, now])
        if (held.rowCount) { await tx.query('COMMIT'); return null }
        const rows = await tx.query<{ id: string; wakeAttempts: number }>(`UPDATE coordinator_events SET
          "wakeAttempts"="wakeAttempts"+1,"wakeLeaseUntil"=$4,"nextWakeAt"=$4,
          "wakeLastError"=CASE WHEN "wakeAttempts"+1 >= ${MAX_WAKE_ATTEMPTS} THEN 'wake_exhausted' ELSE NULL END
          WHERE id IN (SELECT id FROM coordinator_events WHERE "userId"=$1 AND "botId" IS NOT DISTINCT FROM $2::uuid
            AND ${pending} AND "nextWakeAt" <= $3 ORDER BY "createdAt",id LIMIT 50 FOR UPDATE)
          RETURNING id,"wakeAttempts"`, [scope.userId, scope.botId, now, leaseUntil])
        await tx.query('COMMIT')
        return rows.rows.length ? { ...scope, ids: rows.rows.map(row => row.id), leaseUntil, attempt: Math.max(...rows.rows.map(row => row.wakeAttempts)) } : null
      } catch (error) {
        await tx.query('ROLLBACK')
        throw error
      } finally { tx.release() }
    },
    async failed(claim: WakeClaim, code: 'wake_failed' | 'triage_pending'): Promise<void> {
      const next = new Date(clock().getTime() + WAKE_BACKOFF_MS[Math.min(claim.attempt - 1, WAKE_BACKOFF_MS.length - 1)])
      await pool.query(`UPDATE coordinator_events SET "wakeLeaseUntil"=NULL,"nextWakeAt"=$4,"wakeLastError"=$5
        WHERE "userId"=$1 AND id=ANY($2::uuid[]) AND "wakeLeaseUntil"=$3 AND "deliveredAt" IS NULL`,
      [claim.userId, claim.ids, claim.leaseUntil, next, claim.attempt >= MAX_WAKE_ATTEMPTS ? 'wake_exhausted' : code])
    },
    /** Operator-triggered replay resets only a still-pending event. It does
     * not restore cancelled runs, revoked access, or already-consumed events. */
    async replay(id: string): Promise<boolean> {
      return Boolean((await pool.query(`UPDATE coordinator_events SET "wakeAttempts"=0,"nextWakeAt"=$2,"wakeLastError"=NULL
        WHERE id=$1 AND "deliveredAt" IS NULL AND "wakeAttempts">= $3
        AND ("wakeLeaseUntil" IS NULL OR "wakeLeaseUntil" <= $2) RETURNING id`, [id, clock(), MAX_WAKE_ATTEMPTS])).rowCount)
    },
  }
}

/** Delivery errors become persisted retries; provider/error text is never
 * stored in the inbox. A successful start keeps its short recovery lease. */
export async function deliverWake(claim: WakeClaim, deps: {
  triage(scope: WakeScope): Promise<void>
  hasWaking(scope: WakeScope): Promise<boolean>
  start(scope: WakeScope): Promise<void>
  failed(claim: WakeClaim, code: 'wake_failed' | 'triage_pending'): Promise<void>
}): Promise<'started' | 'deferred' | 'failed'> {
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
