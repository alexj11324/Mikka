import type { Pool } from 'pg'

/**
 * A task that needs a machine when none is available (decision
 * 2026-10-31-2200-run-machine-fallback). The wait is one `machine_needed` row in
 * `coordinator_events`, written already delivered so it never wakes a chat: the
 * dispatching bot learns about it from its own tool result. When a machine
 * appears, each open wait gets one `machine_available` event (dedupe key per
 * wait), which wakes that bot through the normal inbox to dispatch again.
 */
export const MACHINE_WAIT_DAYS = 7

export type MachineWaitRequest = { issueId: string; repo: string; note?: string; requestKey?: string }

/** What the bot draws for the person: one choice card, its actions handled by the host. */
export const MACHINE_NEEDED_CARD = {
  title: '这个任务需要一台电脑来跑',
  options: [
    { value: 'mac', label: '在这台电脑上启用', action: 'enableThisMac' },
    { value: 'server', label: '连接我的服务器', action: 'connectServer' },
    { value: 'e2b', label: '填入 E2B Key', action: 'e2bKey' },
  ],
} as const

type Query = Pick<Pool, 'query'>

/** Records (or reuses) the open wait for this chat and task. */
export async function recordMachineWait(pool: Query, wait: { userId: string; botId: string | null; workspaceId: string; request: MachineWaitRequest }) {
  const open = (await pool.query(`SELECT e.id FROM coordinator_events e WHERE e."userId"=$1 AND e."botId" IS NOT DISTINCT FROM $2::uuid
      AND e."issueId"=$3 AND e.kind='machine_needed' AND e."createdAt">now()-make_interval(days=>$4)
      AND NOT EXISTS (SELECT 1 FROM coordinator_events a WHERE a."dedupeKey"='machine_available:'||e.id::text)
    ORDER BY e."createdAt" DESC LIMIT 1`, [wait.userId, wait.botId, wait.request.issueId, MACHINE_WAIT_DAYS])).rows[0]
  if (open) return { waitId: open.id as string }
  const id = crypto.randomUUID()
  await pool.query(`INSERT INTO coordinator_events (id,"userId","botId",kind,"dedupeKey","issueId",payload,tier,"deliveredAt")
    VALUES ($1,$2,$3,'machine_needed',$4,$5,$6,'background',now())`,
  [id, wait.userId, wait.botId, `machine_needed:${id}`, wait.request.issueId, JSON.stringify({ workspaceId: wait.workspaceId, request: wait.request })])
  return { waitId: id }
}

/**
 * A machine appeared: this person's local device came online, or a
 * workspace's cloud became usable (E2B key saved, a thread machine ended;
 * `userId` null wakes every member's waits in that workspace).
 * Returns the waits it woke; a second call wakes nothing twice.
 */
export async function wakeMachineWaits(pool: Query, userId: string | null, source: { deviceId: string } | { workspaceId: string }) {
  const { rows } = await pool.query(`SELECT e.id,e."userId",e."botId",e."issueId",e.payload FROM coordinator_events e
    WHERE ($1::text IS NULL OR e."userId"=$1) AND e.kind='machine_needed' AND e."createdAt">now()-make_interval(days=>$2)
      AND ($3::text IS NULL OR e.payload->>'workspaceId'=$3)
      AND NOT EXISTS (SELECT 1 FROM coordinator_events a WHERE a."dedupeKey"='machine_available:'||e.id::text)
    ORDER BY e."createdAt",e.id LIMIT 50`, [userId, MACHINE_WAIT_DAYS, 'workspaceId' in source ? source.workspaceId : null])
  const woken: string[] = []
  for (const wait of rows) {
    const inserted = await pool.query(`INSERT INTO coordinator_events (id,"userId","botId",kind,"dedupeKey","issueId",payload,tier)
      VALUES ($1,$2,$3,'machine_available',$4,$5,$6,'attention') ON CONFLICT ("dedupeKey") DO NOTHING`,
    [crypto.randomUUID(), wait.userId, wait.botId, `machine_available:${wait.id}`, wait.issueId, JSON.stringify({ waitId: wait.id, ...('deviceId' in source ? { deviceId: source.deviceId } : { cloud: true }), request: wait.payload?.request ?? null })])
    if (inserted.rowCount === 1) woken.push(wait.id)
  }
  return woken
}

/** Heartbeat hook: only a local device that was offline (or new) and is online now. */
export async function wakeMachineWaitsForDevice(pool: Query, userId: string, deviceId: string, wasOffline: boolean) {
  if (!wasOffline) return []
  const device = (await pool.query(`SELECT 1 FROM devices WHERE id=$1 AND "ownerId"=$2 AND kind='local' AND enabled=true AND "removedAt" IS NULL`, [deviceId, userId])).rowCount
  return device ? wakeMachineWaits(pool, userId, { deviceId }) : []
}
