import type { Pool } from 'pg'

/** Reuses the persisted inbox and Coordinator lease. No parallel event bus.
 * Disabled inference leaves events pending without spending retry attempts. */
export async function retryInboxWakes(pool: Pool, deliverCoordinatorWake: (owner: string) => Promise<void>, enabled: boolean, limit = 25) {
  if (!enabled) return { attempted: 0, disabled: true }
  let attempted = 0
  for (; attempted < limit; attempted++) {
    const { rows } = await pool.query<{ id: string; userId: string; wake_attempts: number }>(`WITH due AS (
      SELECT e.id FROM coordinator_events e LEFT JOIN coordinator_sessions s ON s."userId"=e."userId"
      WHERE e."deliveredAt" IS NULL AND e.kind<>'issue_done' AND (e.tier IS NULL OR e.tier<>'background')
        AND e.wake_attempts<5 AND e.wake_next_at<=clock_timestamp()
        AND (e.wake_lease_until IS NULL OR e.wake_lease_until<=clock_timestamp())
        AND (s."leaseUntil" IS NULL OR s."leaseUntil"<=clock_timestamp())
      ORDER BY e.wake_next_at LIMIT 1 FOR UPDATE OF e SKIP LOCKED
    ) UPDATE coordinator_events e SET wake_attempts=wake_attempts+1,wake_lease_until=clock_timestamp()+interval '1 minute'
      FROM due WHERE e.id=due.id RETURNING e.id,e."userId",e.wake_attempts`)
    if (!rows.length) break
    const event = rows[0]
    try {
      await deliverCoordinatorWake(event.userId)
      await pool.query(`UPDATE coordinator_events SET wake_error=NULL,wake_lease_until=NULL,wake_next_at=clock_timestamp()+interval '10 minutes' WHERE id=$1 AND wake_attempts=$2`, [event.id,event.wake_attempts])
    } catch {
      await pool.query(`UPDATE coordinator_events SET wake_error='coordinatorWakeUnavailable',wake_lease_until=NULL,wake_next_at=clock_timestamp()+($3*interval '1 second') WHERE id=$1 AND wake_attempts=$2`, [event.id,event.wake_attempts,Math.min(900,30*2**(event.wake_attempts-1))])
    }
  }
  return { attempted, disabled: false }
}
