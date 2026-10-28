import 'server-only'
import type { Pool } from 'pg'

type Actor = { userId: string; workspaceId: string }
/** A bounded, recoverable provisioning lease; a different owner or machine
 * cannot claim it, and a stale holder cannot renew or release a newer one. */
export async function claimWorkerLease(pool: Pool, actor: Actor, sandboxId: string, leaseId: string) {
  const result = await pool.query(`UPDATE cloud_machines SET "workerLeaseId"=$4,"workerLeaseUntil"=now()+interval '15 minutes'
    WHERE "workspaceId"=$1 AND "ownerId"=$2 AND "sandboxId"=$3
      AND ("workerLeaseId" IS NULL OR "workerLeaseUntil" IS NULL OR "workerLeaseUntil"<=now()) RETURNING "workspaceId"`,
  [actor.workspaceId, actor.userId, sandboxId, leaseId])
  return result.rowCount === 1
}
export async function renewWorkerLease(pool: Pool, actor: Actor, leaseId: string) {
  const result = await pool.query(`UPDATE cloud_machines SET "workerLeaseUntil"=now()+interval '15 minutes'
    WHERE "workspaceId"=$1 AND "ownerId"=$2 AND "workerLeaseId"=$3 AND "workerLeaseUntil">now() RETURNING "workspaceId"`,
  [actor.workspaceId, actor.userId, leaseId])
  return result.rowCount === 1
}
export async function releaseWorkerLease(pool: Pool, actor: Actor, leaseId: string) {
  await pool.query('UPDATE cloud_machines SET "workerLeaseId"=NULL,"workerLeaseUntil"=NULL WHERE "workspaceId"=$1 AND "ownerId"=$2 AND "workerLeaseId"=$3', [actor.workspaceId, actor.userId, leaseId])
}
