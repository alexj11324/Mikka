import type { Pool } from 'pg'
import { MAX_WAKE_ATTEMPTS } from './coordinator/wake-recovery'
import { SCHEDULE_DUE_SQL } from './schedules/store'
import { RUN_RECOVERY_DUE_SQL, runRecoveryDueParams } from './run-recovery-due'

export type ReconcileDue = { wakes: boolean; schedules: boolean; recovery: boolean }

/**
 * The one safety-net check (#1371), every 15 minutes: which event-driven jobs
 * have work already due that no wake or timer picked up. One statement; on an
 * idle database each part reads an empty index or table and all three are false.
 * - wakes: a pending inbox row whose wake is due and unleased (the
 *   coordinator_events_wake_due_idx partial index), or a turn holding a chat
 *   lease that may have ended without letting go (recoverInterruptedTurns).
 * - schedules: any schedule work at or past its due time.
 * - recovery: any run-recovery work due within the minute (items that wait on
 *   outside state are re-checked each minute while they exist).
 */
export async function reconcileDue(pool: Pick<Pool, 'query'>, options: { factoryLifecycle: boolean }): Promise<ReconcileDue> {
  const { rows } = await pool.query<ReconcileDue>(`SELECT
    EXISTS (SELECT 1 FROM coordinator_events WHERE "deliveredAt" IS NULL AND "wakeAttempts" < ${MAX_WAKE_ATTEMPTS}
        AND (tier IS NULL OR tier <> 'background') AND "nextWakeAt" <= now() AND ("wakeLeaseUntil" IS NULL OR "wakeLeaseUntil" <= now()))
      OR EXISTS (SELECT 1 FROM coordinator_sessions WHERE "leaseHolder" LIKE 'wrun\\_%' AND "leaseUntil" > now()) AS wakes,
    coalesce((SELECT min(at) FROM (${SCHEDULE_DUE_SQL}) s) <= now(), false) AS schedules,
    coalesce((SELECT min(at) FROM (${RUN_RECOVERY_DUE_SQL}) r) <= now() + interval '1 minute', false) AS recovery`,
  runRecoveryDueParams(options.factoryLifecycle))
  return rows[0] ?? { wakes: false, schedules: false, recovery: false }
}
