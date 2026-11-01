import 'server-only'
import type { Pool } from 'pg'

type Probe = (workspaceId: string, sandboxId: string) => Promise<'running' | 'sleeping'>

/**
 * Brings stale Bot computers (`cloud_machines`) back in line with E2B. A row
 * that has said running or waking for over an hour is checked: a sandbox E2B
 * no longer has becomes `sleeping` with no sandbox (the next wake creates a
 * new one), and a sandbox E2B paused becomes `sleeping`. Any other answer,
 * including an unusable key, leaves the row alone. Rows mid-provisioning are
 * skipped. Returns how many rows changed.
 */
export async function reconcileCloudMachines(pool: Pick<Pool, 'query'>, probe?: Probe, limit = 20) {
  const check = probe ?? (await import('./e2b-provider')).computerState
  const { sandboxGone } = await import('@/lib/cloud-computer/thread-machines')
  const { rows } = await pool.query<{ workspaceId: string; ownerId: string; sandboxId: string }>(`SELECT "workspaceId","ownerId","sandboxId" FROM cloud_machines
    WHERE state IN ('running','waking') AND "sandboxId" IS NOT NULL AND "lastActiveAt"<now()-interval '1 hour'
      AND ("provisionLeaseUntil" IS NULL OR "provisionLeaseUntil"<now())
    ORDER BY "lastActiveAt" LIMIT $1`, [limit])
  let changed = 0
  for (const row of rows) {
    let state: 'running' | 'sleeping' | 'gone'
    try { state = await check(row.workspaceId, row.sandboxId) } catch (error) {
      if (!sandboxGone(error)) continue
      state = 'gone'
    }
    if (state === 'running') continue
    // The same sandbox and an unchanged state: a wake that raced this check wins.
    const updated = await pool.query(`UPDATE cloud_machines SET state='sleeping'${state === 'gone' ? ',"sandboxId"=NULL,"runtimeReady"=false' : ''}
      WHERE "workspaceId"=$1 AND "ownerId"=$2 AND "sandboxId"=$3 AND state IN ('running','waking')`, [row.workspaceId, row.ownerId, row.sandboxId])
    changed += updated.rowCount ?? 0
  }
  return changed
}
