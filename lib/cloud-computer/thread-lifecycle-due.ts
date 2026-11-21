import type { Pool } from 'pg'

/** Shared by the singleton recovery timer and its bounded sweep. Semantic
 * changes wake immediately; heartbeat/updatedAt writes never become a clock. */
export const THREAD_MACHINE_CLOSED_SQL = `(m."issueId" IS NOT NULL AND
  (i.id IS NULL OR i.status IN ('done','canceled','duplicate') OR i.content->'attrs'->'mikka'->>'deletedAt' IS NOT NULL))`

export const THREAD_MACHINE_DUE_AT_SQL = `CASE
  WHEN m.state='ended' AND m."sandboxId" IS NULL AND m."workerLeaseId" IS NULL AND m."workerLeaseUntil" IS NULL THEN NULL
  WHEN COALESCE((m.lifecycle->>'reconcileUntil')::double precision,0)>extract(epoch FROM clock_timestamp())*1000
    THEN to_timestamp((m.lifecycle->>'reconcileUntil')::double precision/1000)
  WHEN m.lifecycle->>'observedStatus' IS DISTINCT FROM r.status
    OR m.lifecycle->>'observedStop' IS DISTINCT FROM (r."stopRequestedAt" IS NOT NULL)::text
    OR m.lifecycle->>'observedClosed' IS DISTINCT FROM (${THREAD_MACHINE_CLOSED_SQL})::text
    THEN now()
  -- A restore can lose its create response. Wake at the restore cadence rather
  -- than the full provisioning lease so a stuck restore is re-observed
  -- promptly; the persisted operation is reconciled once its lease is no
  -- longer live.
  WHEN m.state='restore'
    THEN LEAST(COALESCE(m."lifecycleAt",now()), COALESCE(m."restoreStartedAt",now())+interval '2 minutes')
  ELSE m."lifecycleAt" END`

/** Reuses run-recovery's durable owner and slow lost-wake reconciliation.
 * There is no separate scheduler or recurring database polling loop. */
export async function reconcileDueThreadMachines(pool: Pool) {
  const { rows } = await pool.query<{ runId: string; ownerId: string; workspaceId: string }>(`SELECT "runId","ownerId","workspaceId" FROM (
    SELECT m."runId",m."ownerId",m."workspaceId",${THREAD_MACHINE_DUE_AT_SQL} AS at
    FROM thread_machines m JOIN agent_runs r ON r.id=m."runId" AND r."userId"=m."ownerId"
    LEFT JOIN issues i ON i.id=m."issueId") due WHERE at<=now() ORDER BY at LIMIT 50`)
  const { reconcileThreadMachine } = await import('./thread-lifecycle')
  let reconciled = 0
  for (const row of rows) {
    try {
      await reconcileThreadMachine(pool, { userId: row.ownerId, workspaceId: row.workspaceId }, row.runId)
      reconciled++
    } catch {
      // A failed DB commit leaves the previous due/intent row intact. The
      // existing recovery timer's bounded failure retry retains ownership.
      console.warn('Thread machine recovery failed', { code: 'thread_machine_reconcile_failed' })
    }
  }
  return { reconciled, pending: rows.length - reconciled }
}
