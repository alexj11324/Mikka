import 'server-only'
import type { Pool } from 'pg'

export interface AccountCloudProvider {
  kill(workspaceId: string, sandboxId: string): Promise<void>
  snapshots(workspaceId: string, sandboxId: string): Promise<string[]>
  deleteSnapshot(workspaceId: string, snapshotId: string): Promise<void>
  endRuns(userId: string, runIds: string[]): Promise<void>
}
/** Everything cleaned up here is the owner's, on the owner's own E2B key (orchestration § 2). */
const ownerProvider = (ownerId: string): AccountCloudProvider => ({
  async kill(_workspaceId, sandboxId) {
    const { Sandbox } = await import('e2b')
    const { e2bApiKey } = await import('@/lib/secrets/e2b-runtime')
    await Sandbox.kill(sandboxId, { apiKey: await e2bApiKey(ownerId, 'Cloud cleanup unavailable'), requestTimeoutMs: 20_000 })
  },
  async snapshots(_workspaceId, sandboxId) {
    const { Sandbox } = await import('e2b')
    const { e2bApiKey } = await import('@/lib/secrets/e2b-runtime')
    const options = { apiKey: await e2bApiKey(ownerId, 'Cloud cleanup unavailable'), requestTimeoutMs: 20_000 }
    const pages = Sandbox.listSnapshots({ ...options, sandboxId }), ids: string[] = []
    while (pages.hasNext) ids.push(...(await pages.nextItems(options)).map(row => row.snapshotId))
    return ids
  },
  async deleteSnapshot(_workspaceId, snapshotId) {
    const { Sandbox } = await import('e2b')
    const { e2bApiKey } = await import('@/lib/secrets/e2b-runtime')
    await Sandbox.deleteSnapshot(snapshotId, { apiKey: await e2bApiKey(ownerId, 'Cloud cleanup unavailable'), requestTimeoutMs: 20_000 })
  },
  async endRuns(userId, runIds) {
    if (!runIds.length) return
    const { afterRunEnded } = await import('@/lib/run-completion-effects')
    for (const runId of runIds) await afterRunEnded(userId, runId)
    const { screenCaptures } = await import('@/lib/captures/screen')
    await screenCaptures.stopRunRecordings(runIds)
  },
})

/** Main Bot computers are keyed by workspace AND owner (20261029080001), never workspace alone. */
export async function cleanupOwnedCloudMachines(ownerId: string, database: Pool, runtime = ownerProvider(ownerId)): Promise<string[]> {
  const reasons = new Set<string>()
  const machines = (await database.query<{ workspaceId: string }>('SELECT "workspaceId" FROM cloud_machines WHERE "ownerId"=$1 ORDER BY "workspaceId"', [ownerId])).rows
  for (const machine of machines) {
    const client = await database.connect()
    let sandboxId: string | null = null, runs: string[] = [], pending = false
    try {
      await client.query('BEGIN')
      const row = (await client.query('SELECT * FROM cloud_machines WHERE "workspaceId"=$1 AND "ownerId"=$2 FOR UPDATE', [machine.workspaceId, ownerId])).rows[0]
      if (!row) { await client.query('COMMIT'); continue }
      // An expired lease is not proof an external allocation did not happen.
      pending = Boolean(row.provisionLeaseId || row.provisionLeaseUntil)
      if (!pending) {
        sandboxId = row.sandboxId
        runs = (await client.query<{ id: string }>(`UPDATE agent_runs r SET status='stopped',"stopRequestedAt"=COALESCE(r."stopRequestedAt",now()),"finishedAt"=COALESCE(r."finishedAt",now())
          WHERE r."userId"=$1 AND r.status=ANY($4::text[]) AND (
            (r."deviceId"=$3 AND $3::uuid IS NOT NULL) OR EXISTS(SELECT 1 FROM computer_run_bindings b WHERE b."runId"=r.id AND b."ownerId"=$1 AND b."workspaceId"=$2 AND NOT EXISTS(SELECT 1 FROM thread_machines t WHERE t."runId"=r.id))) RETURNING r.id`, [ownerId, machine.workspaceId, row.deviceId, ['queued','preparing','running','paused','waiting_input','finishing']])).rows.map(item => item.id)
        if (row.deviceId) await client.query('UPDATE device_tokens SET "revokedAt"=COALESCE("revokedAt",now()) WHERE "userId"=$1 AND "boundDeviceId"=$2', [ownerId, row.deviceId])
        await client.query('UPDATE cloud_machines SET state=\'error\',"runtimeReady"=false,"workerLeaseId"=NULL,"workerLeaseUntil"=NULL WHERE "workspaceId"=$1 AND "ownerId"=$2', [machine.workspaceId, ownerId])
      }
      await client.query('COMMIT')
    } catch { await client.query('ROLLBACK'); reasons.add('cloud_runtime_cleanup_required'); continue }
    finally { client.release() }
    if (pending) { reasons.add('cloud_provision_cleanup_pending'); continue }
    try { await runtime.endRuns(ownerId, runs); if (sandboxId) await runtime.kill(machine.workspaceId, sandboxId) }
    catch { reasons.add('cloud_runtime_cleanup_required') }
  }
  // Keep source references until every provider deletion acknowledges. Repeated
  // DELETE of a known owned object is idempotent; no mapping disappears first.
  const sources = (await database.query<{ workspaceId: string; sandboxId: string }>(`SELECT "workspaceId","sandboxId" FROM cloud_machines WHERE "ownerId"=$1 AND "sandboxId" IS NOT NULL
    UNION SELECT "workspaceId","sandboxId" FROM thread_machines WHERE "ownerId"=$1 AND "sandboxId" IS NOT NULL`, [ownerId])).rows
  const snapshots = (await database.query<{ workspaceId: string; snapshotId: string }>(`SELECT "workspaceId","snapshotId" FROM workspace_snapshots WHERE "ownerId"=$1
    UNION SELECT "workspaceId","snapshotId" FROM thread_machines WHERE "ownerId"=$1 AND "snapshotId"<>'pending'`, [ownerId])).rows
  const owned = new Map(snapshots.map(row => [`${row.workspaceId}:${row.snapshotId}`, row]))
  for (const source of sources) {
    try { for (const snapshotId of await runtime.snapshots(source.workspaceId, source.sandboxId)) owned.set(`${source.workspaceId}:${snapshotId}`, { workspaceId: source.workspaceId, snapshotId }) }
    catch { reasons.add('cloud_snapshot_inventory_pending') }
  }
  for (const snapshot of owned.values()) {
    try { await runtime.deleteSnapshot(snapshot.workspaceId, snapshot.snapshotId) }
    catch { reasons.add('cloud_snapshot_cleanup_required') }
  }
  return [...reasons]
}
