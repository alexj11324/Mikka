import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { HarnessInfo } from '@mikka/protocol/harness'
import { daemonTestMode } from '@mikka/protocol/repository'

export function localExecutionHarnesses(infos: readonly HarnessInfo[], env: Record<string, string | undefined> = process.env): string[] {
  return [...new Set(infos.filter(info => info.installed &&
    (info.harness === 'claude_code' || info.harness === 'codex' || (info.harness === 'mock' && daemonTestMode(env))))
    .map(info => info.harness))].sort()
}

/** Local execution identities are infrastructure, never user-managed Bots. */
export async function ensureDeviceAgents(pool: Pool, ownerId: string, deviceId: string, infos: readonly HarnessInfo[]) {
  const desired = localExecutionHarnesses(infos)
  const query = `SELECT d.kind,a.harness FROM devices d LEFT JOIN agents a
    ON a."deviceId"=d.id AND a."userId"=d."ownerId" AND a.name=a.harness || ' ' || d.id::text
    WHERE d.id=$2 AND d."ownerId"=$1 ORDER BY a.harness`
  const rows = (await pool.query(query, [ownerId, deviceId])).rows
  if (!rows.length || rows[0].kind !== 'local') return
  const actual = rows.flatMap(row => row.harness ? [row.harness] : [])
  // Normal 15-second heartbeats do one read, without opening a transaction
  // or acquiring an advisory lock.
  if (actual.length === desired.length && actual.every((harness, i) => harness === desired[i])) return
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('device-agents:' || $1,0))", [deviceId])
    const device = (await client.query(`SELECT harnesses FROM devices WHERE id=$1 AND "ownerId"=$2 AND kind='local' FOR UPDATE`, [deviceId, ownerId])).rows[0]
    if (device) {
      // A newer registration/heartbeat may have won while this one waited.
      const current = localExecutionHarnesses(device.harnesses)
      for (const harness of current) {
        await client.query(`INSERT INTO agents (id,"userId",harness,name,"deviceId") VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT ("userId",lower(name)) DO UPDATE SET "deviceId"=EXCLUDED."deviceId","updatedAt"=now()
          WHERE agents.harness=EXCLUDED.harness`, [randomUUID(), ownerId, harness, `${harness} ${deviceId}`, deviceId])
      }
      // Keep historical runs and their FK; a removed CLI only loses its live
      // device binding. Reinstalling revives the same identity via its name.
      await client.query(`UPDATE agents SET "deviceId"=NULL,"updatedAt"=now() WHERE "userId"=$1 AND "deviceId"=$2
        AND name=harness || ' ' || $2 AND NOT (harness=ANY($3::text[]))`, [ownerId, deviceId, current])
    }
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
