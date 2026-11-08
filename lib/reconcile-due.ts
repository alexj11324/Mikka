import type { Pool } from 'pg'
import { MAX_WAKE_ATTEMPTS } from './coordinator/wake-recovery'
import { SCHEDULE_DUE_SQL } from './schedules/store'
import { RUN_RECOVERY_DUE_SQL, runRecoveryDueParams } from './run-recovery-due'
import { ACCOUNT_DELETIONS_DUE_SQL } from './account-deletions-due'
import { AUDIT_OUTBOX_DUE_SQL, AUDIT_RETENTION_DUE_SQL } from './audit-retention-due'

export type ReconcileDue = { wakes: boolean; schedules: boolean; recovery: boolean; deletions: boolean; audit: boolean; pushReceipts: boolean; workspaceEphemera: boolean }

/**
 * The one safety-net check (#1371), every 15 minutes: which event-driven jobs
 * have work already due that no wake or timer picked up. One statement; on an
 * idle database each part reads an empty index or table and all are false.
 * - wakes: a pending inbox row whose wake is due and unleased (the
 *   coordinator_events_wake_due_idx partial index), or a turn holding a chat
 *   lease that may have ended without letting go (recoverInterruptedTurns).
 * - schedules: any schedule work at or past its due time.
 * - recovery: any run-recovery work due within the minute (items that wait on
 *   outside state are re-checked each minute while they exist).
 * - deletions: an account deletion, chat file or retired object due for cleanup.
 * - audit: audit events past their retention, or (a second statement, on the workspace
 *   database where the outbox lives) an audit receipt not yet delivered.
 * - pushReceipts: a due, unleased push receipt whose Workflow wake was lost.
 * - workspaceEphemera: expired live-read residues or source references.
 */
export async function reconcileDue(pool: Pick<Pool, 'query'>, options: { factoryLifecycle: boolean; workspace?: Pick<Pool, 'query'> }): Promise<ReconcileDue> {
  const { rows } = await pool.query<ReconcileDue>(`SELECT
    EXISTS (SELECT 1 FROM coordinator_events WHERE "deliveredAt" IS NULL AND "wakeAttempts" < ${MAX_WAKE_ATTEMPTS}
        AND (tier IS NULL OR tier <> 'background') AND "nextWakeAt" <= now() AND ("wakeLeaseUntil" IS NULL OR "wakeLeaseUntil" <= now()))
      OR EXISTS (SELECT 1 FROM coordinator_sessions WHERE "leaseHolder" LIKE 'wrun\\_%' AND "leaseUntil" > now()) AS wakes,
    coalesce((SELECT min(at) FROM (${SCHEDULE_DUE_SQL}) s) <= now(), false) AS schedules,
    coalesce((SELECT min(at) FROM (${RUN_RECOVERY_DUE_SQL}) r) <= now() + interval '1 minute', false) AS recovery,
    coalesce((SELECT min(at) FROM (${ACCOUNT_DELETIONS_DUE_SQL}) d) <= now(), false) AS deletions,
    coalesce((SELECT min(at) FROM (${AUDIT_RETENTION_DUE_SQL}) a) <= now(), false) AS audit,
    EXISTS (SELECT 1 FROM mobile_push_receipts WHERE (next_check_at<=now() OR created_at<=now()-interval '1 day')
      AND (lease_until IS NULL OR lease_until<=now())) AS "pushReceipts",
    (EXISTS (SELECT 1 FROM coding_workspace_requests WHERE "expiresAt"<=now())
      OR EXISTS (SELECT 1 FROM coding_workspace_mentions WHERE "expiresAt"<=now())) AS "workspaceEphemera"`,
  runRecoveryDueParams(options.factoryLifecycle))
  const due = rows[0] ?? { wakes: false, schedules: false, recovery: false, deletions: false, audit: false, pushReceipts: false, workspaceEphemera: false }
  if (!due.audit && options.workspace) {
    const outbox = await options.workspace.query<{ due: boolean }>(`SELECT coalesce((SELECT min(at) FROM (${AUDIT_OUTBOX_DUE_SQL}) o) <= now(), false) AS due`)
    due.audit = Boolean(outbox.rows[0]?.due)
  }
  return due
}
