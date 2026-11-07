import type { PoolClient } from 'pg'

// A new token is not handed off until its insertion commits; lastUsedAt is null.
export const THREAD_CREDENTIAL_SQL = "INSERT INTO device_tokens (id,\"userId\",name,\"tokenHash\",\"boundDeviceId\",\"boundWorkspaceId\",\"expiresAt\") VALUES ($1,$2,$3,$4,$5,$6,now()+interval '24 hours') RETURNING clock_timestamp() AS now"

export const FINISH_THREAD_REGISTRATION = `UPDATE thread_machines m SET state='running',"lastActiveAt"=now(),"runningSince"=COALESCE(m."runningSince",now()),
"workerLeaseId"=NULL,"workerLeaseUntil"=NULL,"lifecycleAt"=now(),
lifecycle=m.lifecycle||jsonb_build_object('phase',CASE WHEN m.lifecycle->>'phase'='create_requested' THEN 'created' ELSE 'resumed' END,'owner','run-recovery','failures',0)
FROM devices d JOIN device_tokens t ON t."boundDeviceId"=d.id,agent_runs r
WHERE m."runId"=$1 AND m."workerLeaseId"=$2 AND m.state<>'ended'
AND r.id=m."runId" AND r."stopRequestedAt" IS NULL
AND d.id=$3 AND m."deviceId"=d.id AND d."ownerId"=m."ownerId"
AND t."tokenHash"=$4 AND t."revokedAt" IS NULL AND d."lastSeenAt">=$5 AND t."lastUsedAt">=$5
RETURNING m."runId",m."issueId",m."sandboxId",m.epoch,m.lifecycle,m."computeSeconds"`

export type ThreadRegistrationMaintenance = {
  status: 'succeeded' | 'failed' | 'stopped' | 'cancelled'
  /** PostgreSQL's own timestamp text, preserving microseconds on this connection. */
  stopRequestedAt: string | null
}

// Maintenance may retain a historical stop only while its original terminal
// status, exact stop marker and native-exit proof still hold. Ordinary task
// completion never receives this exception.
const maintenanceFence = (statusParameter: number, stopParameter: number) =>
  'r.status=$' + statusParameter + ' AND r."stopRequestedAt"::text IS NOT DISTINCT FROM $' + stopParameter +
  ' AND ($' + stopParameter + '::text IS NULL OR r.report#>>\'{safePoint,session}\'=\'exited\')'

const maintenanceFinish = FINISH_THREAD_REGISTRATION.replace('r."stopRequestedAt" IS NULL', maintenanceFence(6, 7))

/**
 * Preserve run -> machine lock order. The UPDATE is a new statement after any
 * lock wait, so it sees committed revocations. It does not take token locks:
 * credential revocation owns its token before stopping the run.
 */
export async function finishThreadRegistration(client: Pick<PoolClient, 'query'>, runId: string,
  leaseId: string, deviceId: string, tokenSha256: string, startedAt: Date, maintenance?: ThreadRegistrationMaintenance) {
  if (maintenance && (!['succeeded','failed','stopped','cancelled'].includes(maintenance.status) ||
    !(maintenance.stopRequestedAt === null || (typeof maintenance.stopRequestedAt === 'string' &&
      maintenance.stopRequestedAt.length > 0 && maintenance.stopRequestedAt.length <= 128)))) throw new Error('Invalid registration maintenance fence')
  const maintenanceValues = maintenance ? [maintenance.status, maintenance.stopRequestedAt] : []
  await client.query('BEGIN')
  try {
    const held = await client.query(
      'SELECT 1 FROM agent_runs r JOIN thread_machines m ON m."runId"=r.id WHERE r.id=$1 AND ' +
        (maintenance ? maintenanceFence(3, 4) : 'r."stopRequestedAt" IS NULL') +
        ' AND m."workerLeaseId"=$2 AND m.state<>\'ended\' FOR UPDATE OF r,m',
      [runId, leaseId, ...maintenanceValues])
    if (!held.rowCount) {
      await client.query('ROLLBACK')
      return { rowCount: 0, rows: [] }
    }
    const result = await client.query(maintenance ? maintenanceFinish : FINISH_THREAD_REGISTRATION, [runId, leaseId, deviceId, tokenSha256, startedAt, ...maintenanceValues])
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}
