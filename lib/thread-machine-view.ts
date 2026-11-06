import 'server-only'
import type { Pool } from 'pg'
import { deviceIsOnline } from '@/lib/device-presence'
import { cloudMachineState, deviceMachineKind, type ThreadMachine } from '@/lib/thread-machine'

type Row = {
  runId: string; kind: string | null; deviceType: string | null; name: string | null; platform: string | null; arch: string | null
  hostname: string | null; deviceId: string | null; lastSeenAt: Date | null
  sandboxId: string | null; template: string | null; machineState: string | null; machineCreatedAt: Date | null; endedAt: Date | null
}

/**
 * Where the thread's live run runs, for its owner only: the device it was given
 * and, for a cloud run, its E2B sandbox. Earlier runs of the chain are the
 * fallback while the newest one has no machine yet. One indexed read; a
 * computer's presence asks the gateway only when its heartbeat is stale.
 */
export async function readThreadMachine(pool: Pool, ownerId: string, runIds: readonly string[]): Promise<ThreadMachine | null> {
  if (!runIds.length) return null
  const { rows } = await pool.query<Row>(`SELECT r.id AS "runId", d.kind, d."deviceType", d.name, d.platform, d.arch, d.hostname,
      d.id AS "deviceId", d."lastSeenAt", tm."sandboxId", tm."snapshotId" AS template, tm.state AS "machineState",
      tm."createdAt" AS "machineCreatedAt", tm."endedAt"
    FROM agent_runs r
    LEFT JOIN devices d ON d.id = r."deviceId"
    LEFT JOIN thread_machines tm ON tm."runId" = r.id AND tm."ownerId" = r."userId"
    WHERE r.id = ANY($1::uuid[]) AND r."userId" = $2`, [runIds, ownerId])
  const byId = new Map(rows.map(row => [row.runId, row]))
  // Newest first: the live end of the chain decides, an earlier attempt only stands in.
  const row = [...runIds].reverse().map(id => byId.get(id)).find(item => item && (item.deviceId || item.sandboxId))
  if (!row) return null
  if (row.sandboxId || row.kind === 'cloud') {
    return {
      kind: 'cloud', state: row.machineState ? cloudMachineState(row.machineState) : 'ended', name: null,
      platform: null, arch: null, hostname: null, lastSeenAt: null,
      cloud: row.sandboxId ? { sandboxId: row.sandboxId, template: row.template ?? '', createdAt: (row.machineCreatedAt ?? new Date(0)).toISOString(), endedAt: row.endedAt?.toISOString() ?? null } : null,
    }
  }
  const online = row.deviceId ? await deviceIsOnline({ id: row.deviceId, lastSeenAt: row.lastSeenAt }) : false
  return {
    kind: deviceMachineKind(row), state: online ? 'online' : 'offline', name: row.name,
    platform: row.platform, arch: row.arch, hostname: row.kind !== 'cloud' && row.deviceType === 'server' ? row.hostname : null,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null, cloud: null,
  }
}
