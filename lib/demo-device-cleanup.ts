import 'server-only'
import { db, pool } from './db'
import { stopOwnedRun } from './run-control'
import { completeRunForDevice } from './run-completion'
import { afterRunEnded } from './run-completion-effects'
import { removeOwnedDevice } from './device-removal'

const active = ['queued', 'preparing', 'running', 'paused', 'waiting_input', 'finishing']
const exactDemo = `d.id::text LIKE 'de30000%' AND d."daemonVersion"='0.9.4' AND d.kind='local'`

/** One-off #1517 retirement. Identity is the prefix AND daemon version, never the displayed name. */
export async function removeDemoDevices(apply = false) {
  const targets = (await pool.query<{ id: string; ownerId: string }>(`SELECT d.id,d."ownerId" FROM devices d WHERE ${exactDemo} AND d."removedAt" IS NULL ORDER BY d.id`)).rows
  const counts = { devices: targets.length, activeRuns: 0, stoppedRuns: 0, removedDevices: 0 }
  for (const target of targets) {
    // Synthetic fixtures have no live credential, claim lease or machine. If a row has
    // become real, do not manufacture its daemon's acknowledgement or remove it.
    const { rows: [guard] } = await pool.query<{ eligible: boolean; credential: boolean; execution: boolean }>(`SELECT
      (${exactDemo} AND d."removedAt" IS NULL AND NOT d.enabled) AS eligible,
      EXISTS(SELECT 1 FROM device_tokens t WHERE t."userId"=d."ownerId" AND t."revokedAt" IS NULL
        AND (t."expiresAt" IS NULL OR t."expiresAt">now()) AND (t."boundDeviceId"=d.id OR EXISTS(SELECT 1 FROM device_token_devices b WHERE b."tokenId"=t.id AND b."deviceId"=d.id))) AS credential,
      EXISTS(SELECT 1 FROM agent_runs r WHERE r."deviceId"=d.id AND r.status=ANY($2::text[]) AND
        (r."userId"<>d."ownerId" OR r."deviceTokenId" IS NOT NULL OR r."leaseExpiresAt">now()
         OR EXISTS(SELECT 1 FROM thread_machines m WHERE m."runId"=r.id))) AS execution
      FROM devices d WHERE d.id=$1`, [target.id, active])
    if (!guard?.eligible || guard.credential || guard.execution) throw new Error('Demo cleanup refused: target has changed or has real execution evidence')
    const runs = (await pool.query<{ id: string; issueId: string | null }>(`SELECT id,"issueId" FROM agent_runs WHERE "deviceId"=$1 AND "userId"=$2 AND status=ANY($3::text[]) ORDER BY id`, [target.id, target.ownerId, active])).rows
    counts.activeRuns += runs.length
    if (!apply) continue
    for (const run of runs) {
      const ended = await stopOwnedRun(db, target.ownerId, run.id)
      if (!ended) {
        const completed = await completeRunForDevice(target.ownerId, run, { stopReason: 'cancelled' })
        if (!completed) throw new Error('Demo cleanup refused: run could not be finalized')
      }
      await afterRunEnded(target.ownerId, run.id)
      counts.stoppedRuns++
    }
    // This normal removal path refuses any active run that appeared in the meantime,
    // detaches agents, revokes bound credentials, and publishes the existing live keys.
    await removeOwnedDevice(target.ownerId, target.id)
    counts.removedDevices++
  }
  return counts
}
