import { runMessagePrompt } from './run-message-prompt'
import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import { and, asc, eq, or, sql, getTableColumns, inArray, isNull } from 'drizzle-orm'
import { db, pool } from '@/lib/db'
import { cloudDeviceScopeAllows } from '@/lib/device-token-scope'
import { z } from 'zod'
import { agentRuns, deviceTokens, devices, runMessages } from '@/lib/db/schema'
import type { RunCommand } from '@mikka/protocol/device'
import type { DeviceCommandKind } from '@/lib/device-management'
import { deviceRequestCaller } from '@/lib/device-request-context'
import { ackMailboxNotices, pendingMailboxNotices } from '@/lib/device-mailbox-notices'

/**
 * The single workspace this MVP serves. The protocol's register answer
 * carries a workspace id; the app itself has no workspaces yet.
 */
export const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'

/** Run states where the daemon may still be working: not terminal. */
const LIVE_RUN_STATUSES = ['queued', 'preparing', 'running', 'paused', 'waiting_input', 'finishing'] as const

/**
 * A run the server took back from this device: its lease ended (a closed
 * session, a revocation) and it is still leased or was reclaimed as lost.
 * A daemon that reconnects within its local grace still holds such a run;
 * the commands read hands it a `stop` (decision 2026-11-17-2215, which
 * replaced the heartbeat's `revoked` list). Bounded to recent lease ends: a
 * daemon past its local grace has stopped the run itself.
 */
export const TAKEN_BACK_WINDOW = '10 minutes'
const takenBackSql = (alias: string) => `(${alias}."leaseExpiresAt"<=now() AND ${alias}."leaseExpiresAt">now()-interval '${TAKEN_BACK_WINDOW}'
  AND (${alias}.status IN ('preparing','running','paused','waiting_input','finishing') OR ${alias}."stopReason"='device_lost'))`

export function newDeviceToken(): string {
  return `orv_${randomBytes(32).toString('base64url')}`
}

/** Only the hash is stored; a stolen database yields no usable token. */
export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Used by both the manual token action and the browser device grant. */
export async function issueDeviceToken(userId: string, name = ''): Promise<string> {
  const token = newDeviceToken()
  await db.insert(deviceTokens).values({
    id: crypto.randomUUID(), userId, name, tokenHash: hashDeviceToken(token),
  })
  return token
}

export interface DeviceCaller {
  userId: string
  tokenId: string
  scopeDeviceId?: string
  scopeWorkspaceId?: string
  /** A removed local credential can only deliver its uninstall receipt. */
  removingDeviceId?: string
}

/**
 * The daemon authenticates with `Authorization: Bearer <device token>`.
 * `null` means the token is missing, unknown or revoked.
 */
export async function authenticateDevice(request: Request): Promise<DeviceCaller | null> {
  const admitted = deviceRequestCaller.getStore()
  if (admitted) return admitted
  const header = request.headers.get('authorization') ?? ''
  if (!header.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length).trim()
  if (!token) return null
  const [row] = await db
    .select({ id: deviceTokens.id, userId: deviceTokens.userId, lastUsedAt: deviceTokens.lastUsedAt, boundDeviceId: deviceTokens.boundDeviceId, boundWorkspaceId: deviceTokens.boundWorkspaceId, expiresAt: deviceTokens.expiresAt })
    .from(deviceTokens)
    .where(and(eq(deviceTokens.tokenHash, hashDeviceToken(token)), isNull(deviceTokens.revokedAt)))
    .limit(1)
  if (!row) return null
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null
  let removingDeviceId: string | undefined
  if (row.expiresAt && !row.boundDeviceId && !row.boundWorkspaceId) {
    const removed = await pool.query<{ id: string }>(`SELECT d.id FROM device_token_devices t JOIN devices d ON d.id=t."deviceId"
      WHERE t."tokenId"=$1 AND d."ownerId"=$2 AND d."removedAt" IS NOT NULL`, [row.id, row.userId])
    if (removed.rowCount) {
      // Only the device's report can deliver its uninstall receipt (app/v1/devices/[deviceId]/report).
      const path = new URL(request.url).pathname.replace(/^\/mikka(?=\/)/, '')
      const report = /^\/v1\/devices\/([^/]+)\/report$/.exec(path)
      if (request.method !== 'POST' || !report || !removed.rows.some(device => device.id === report[1])) return null
      removingDeviceId = report[1]
    }
  }
  if (row.boundDeviceId || row.boundWorkspaceId) {
    if (!row.boundDeviceId || !row.boundWorkspaceId || !row.expiresAt) return null
    const machine = await pool.query(`SELECT 1 FROM (SELECT "deviceId","workspaceId","ownerId" FROM cloud_machines UNION ALL SELECT "deviceId","workspaceId","ownerId" FROM thread_machines WHERE state <> 'ended') m JOIN devices d ON d.id=m."deviceId" WHERE m."deviceId"=$1 AND m."workspaceId"=$2 AND m."ownerId"=$3 AND d."ownerId"=$3 AND d.kind=$4`, [row.boundDeviceId, row.boundWorkspaceId, row.userId, 'cloud'])
    if (!machine.rowCount) return null
    const allowed = await cloudDeviceScopeAllows(request, row.boundDeviceId, async (runId, deviceId) => {
      if (!z.uuid().safeParse(runId).success) return false
      const [run] = await db.select({ id: agentRuns.id }).from(agentRuns).where(and(eq(agentRuns.id, runId), eq(agentRuns.userId, row.userId), eq(agentRuns.deviceId, deviceId))).limit(1)
      return Boolean(run)
    })
    if (!allowed) return null
  }
  // One write a minute is enough to show that a token is still in use.
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    await db.update(deviceTokens).set({ lastUsedAt: new Date() }).where(and(eq(deviceTokens.id, row.id), isNull(deviceTokens.revokedAt)))
  }
  return { userId: row.userId, tokenId: row.id, ...(row.boundDeviceId && row.boundWorkspaceId ? { scopeDeviceId: row.boundDeviceId, scopeWorkspaceId: row.boundWorkspaceId } : {}), ...(removingDeviceId ? { removingDeviceId } : {}) }
}

/** Whether the caller owns this (not removed) device, reading only what a daemon poll needs. */
export async function ownsDevice(deviceId: string, userId: string): Promise<{ id: string; enabled: boolean } | null> {
  const [row] = await db
    .select({ id: devices.id, enabled: devices.enabled })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.ownerId, userId), isNull(devices.removedAt)))
    .limit(1)
  return row ?? null
}

const { harnesses: _harnesses, computerUse: _computerUse, updateFailure: _updateFailure, ...deviceColumns } = getTableColumns(devices)

/**
 * A removed device (a tombstone kept for run history) is no longer owned.
 * Almost every daemon request asks, so the large report columns (harnesses,
 * computerUse, updateFailure) are left out; ownedDeviceWithReport reads them.
 */
export async function ownedDevice(deviceId: string, userId: string) {
  const [row] = await db
    .select(deviceColumns)
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.ownerId, userId), isNull(devices.removedAt)))
    .limit(1)
  return row ?? null
}

/** ownedDevice with the daemon's whole report, for the routes that check its harnesses. */
export async function ownedDeviceWithReport(deviceId: string, userId: string) {
  const [row] = await db
    .select()
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.ownerId, userId), isNull(devices.removedAt)))
    .limit(1)
  return row ?? null
}

/**
 * Whether the caller owns this (not removed) device; if so, records that this
 * credential acts as it, so removing the device revokes the credential
 * (lib/device-removal.ts). The device row is read FOR SHARE: a concurrent
 * removal commits first and the device then counts as unknown.
 */
export async function linkDeviceToken(caller: Pick<DeviceCaller, 'userId' | 'tokenId'>, deviceId: string): Promise<boolean> {
  if (!z.uuid().safeParse(deviceId).success) return false
  const { rows } = await pool.query(`WITH d AS (
      SELECT id FROM devices WHERE id=$1 AND "ownerId"=$2 AND "removedAt" IS NULL FOR SHARE
    ), linked AS (
      INSERT INTO device_token_devices ("tokenId","deviceId","userId")
      SELECT $3, id, $2 FROM d
      ON CONFLICT DO NOTHING
    ) SELECT id FROM d`, [deviceId, caller.userId, caller.tokenId])
  return rows.length > 0
}

/**
 * Whether `deviceWork` could find anything: one statement, one round trip,
 * with the credential check inside it (a revoked or expired credential
 * throws, as any fenced query does). The commands read asks this before the
 * full read, which stays fenced and is the only path that hands over message
 * text or queued runs. Mailbox notices are not modelled: with them on, a live
 * run always counts as possible work and the full read decides.
 * With `skipDeviceCommands` (a daemon that reads them from the poll), the same
 * statement also returns the oldest pending device command outside that list:
 * only its id and kind, which the report hands over too.
 */
export async function deviceMayHaveWork(deviceId: string, skip: readonly string[], options: { activeTurnSteer?: boolean; mailboxNotices?: boolean; queued?: boolean; skipDeviceCommands?: readonly string[] } = {}): Promise<{ work: boolean; deviceCommand: { id: string; kind: DeviceCommandKind } | null }> {
  const uuid = (id: string) => z.uuid().safeParse(id).success
  const { readUnderDeviceAuthority } = await import('@/lib/db')
  const [work, deviceCommand] = await readUnderDeviceAuthority<[boolean, { id: string; kind: DeviceCommandKind } | null]>(`json_build_array(EXISTS (SELECT 1 FROM agent_runs r WHERE r."deviceId"=$1 AND NOT (r.id = ANY($3::uuid[]))
    AND (r.status = ANY($2::text[]) OR ${takenBackSql('r')})
    AND (r."stopRequestedAt" IS NOT NULL OR ${takenBackSql('r')} OR ($4 AND r.status='queued')
      OR ($5 AND r.status IN ('preparing','running','waiting_input'))
      OR EXISTS (SELECT 1 FROM run_messages m WHERE m."runId"=r.id AND m."deliveredAt" IS NULL AND m.failure IS NULL
        AND ($8 OR NOT EXISTS (SELECT 1 FROM coordinator_events e WHERE e.id=m.id AND e."userId"=m."userId" AND e.payload#>>'{threadSubmission,delivery}'='steer'))))),
    CASE WHEN $6 THEN (SELECT json_build_object('id', c.id, 'kind', c.kind) FROM device_management_commands c
      WHERE c."deviceId"=$1 AND c."completedAt" IS NULL AND NOT (c.id = ANY($7::uuid[])) ORDER BY c."createdAt" LIMIT 1) END)`,
  [deviceId, [...LIVE_RUN_STATUSES], skip.filter(uuid), Boolean(options.queued), Boolean(options.mailboxNotices), Boolean(options.skipDeviceCommands), (options.skipDeviceCommands ?? []).filter(uuid), Boolean(options.activeTurnSteer)])
  return { work, deviceCommand }
}

/**
 * What a device has waiting, read with one query of its runs per poll:
 * - `commands`: a person's message to a running agent (repeats until acked)
 *   and a stop someone asked for (repeats until the run ends);
 * - `queuedRuns`: runs waiting for it to claim them (only with `queued`).
 * Runs in `skip` (already handed over) are left out.
 */
export async function deviceWork(deviceId: string, skip: readonly string[], options: { activeTurnSteer?: boolean; mailboxNotices?: boolean; queued?: boolean } = {}): Promise<{ commands: RunCommand[]; queuedRuns: string[] }> {
  const rows = await db
    .select({ id: agentRuns.id, status: agentRuns.status, stopRequestedAt: agentRuns.stopRequestedAt, takenBack: sql<boolean>`${sql.raw(takenBackSql('"agent_runs"'))}` })
    .from(agentRuns)
    .where(and(eq(agentRuns.deviceId, deviceId), or(inArray(agentRuns.status, [...LIVE_RUN_STATUSES]), sql.raw(takenBackSql('"agent_runs"')))))
  const skipped = new Set(skip)
  // A run whose lease ended gets its stop here, whether the server took it back
  // or a stop (policy, revocation, a person) ended the lease at the same time.
  const takenBack = rows.filter(run => run.takenBack && !skipped.has(run.id)).map(run => ({ kind: 'stop' as const, runId: run.id }))
  const runs = rows.filter(run => (LIVE_RUN_STATUSES as readonly string[]).includes(run.status) && !run.takenBack)
  const live = runs.filter(run => !skipped.has(run.id))
  const queuedRuns = options.queued ? live.filter(run => run.status === 'queued').map(run => run.id).slice(0, 100) : []
  if (live.length === 0) return { commands: takenBack.slice(0, 500), queuedRuns }
  const messages = await db
    .select({ id: runMessages.id, runId: runMessages.runId, text: runMessages.text, origin: runMessages.origin,
      steer: sql<boolean>`EXISTS (SELECT 1 FROM coordinator_events e WHERE e.id=${runMessages.id} AND e."userId"=${runMessages.userId} AND e.payload#>>'{threadSubmission,delivery}'='steer')` })
    .from(runMessages)
    .where(and(isNull(runMessages.deliveredAt), sql`failure IS NULL`, inArray(runMessages.runId, live.map(run => run.id))))
    .orderBy(asc(runMessages.createdAt))
    .limit(500)
  // The runId filter above excludes mailbox messages, whose runId is null.
  const inputs: RunCommand[] = messages.flatMap(({ id, runId, text, origin, steer }) => runId && (!steer || options.activeTurnSteer) ? [{ kind: steer ? 'steer' as const : 'input' as const, runId, messageId: id, text: runMessagePrompt({ id, runId, origin, text }) }] : [])
  const stops: RunCommand[] = live.filter(run => run.stopRequestedAt).map(run => ({ kind: 'stop', runId: run.id }))
  const notices = options.mailboxNotices ? await pendingMailboxNotices(deviceId, live.filter(run => !run.stopRequestedAt).map(run => run.id)) : []
  return { commands: [...stops, ...takenBack, ...notices, ...inputs].slice(0, 500), queuedRuns }
}

/** Marks messages the agent now holds; called by the daemon's ack. */
export async function ackCommands(deviceId: string, delivered: readonly string[], refusedSteers: readonly string[] = []): Promise<void> {
  if (refusedSteers.length) {
    const refused = await pool.query<{ runId: string }>(`UPDATE run_messages m SET failure='threadDeliveryUnavailable'
      FROM agent_runs r,coordinator_events e WHERE m.id=ANY($2::uuid[]) AND m."runId"=r.id AND r."deviceId"=$1
        AND r."userId"=m."userId" AND e.id=m.id AND e."userId"=m."userId" AND e.payload#>>'{threadSubmission,delivery}'='steer'
        AND m."deliveredAt" IS NULL AND m.failure IS NULL RETURNING m."runId"`, [deviceId, refusedSteers])
    const { runChanged } = await import('./live/panels')
    for (const runId of new Set(refused.rows.map(row => row.runId))) await runChanged(pool, runId)
  }
  if (delivered.length === 0) return
  await ackMailboxNotices(deviceId, delivered)
  const owned = await db
    .select({ id: runMessages.id, runId: runMessages.runId, steer: sql<boolean>`EXISTS (SELECT 1 FROM coordinator_events e WHERE e.id=${runMessages.id}
      AND e."userId"=${runMessages.userId} AND e.payload#>>'{threadSubmission,delivery}'='steer')` })
    .from(runMessages)
    .innerJoin(agentRuns, eq(agentRuns.id, runMessages.runId))
    .where(and(eq(agentRuns.deviceId, deviceId), inArray(runMessages.id, [...delivered])))
  if (owned.length === 0) return
  const acknowledged = await db
    .update(runMessages)
    .set({ deliveredAt: new Date() })
    .where(and(inArray(runMessages.id, owned.map(row => row.id)), isNull(runMessages.deliveredAt),sql`failure IS NULL`)).returning({ id: runMessages.id })
  const changed = new Set(acknowledged.map(row => row.id))
  const steered = owned.flatMap(row => row.steer && row.runId && changed.has(row.id) ? [row.runId] : [])
  if (steered.length) {
    const { runChanged } = await import('./live/panels')
    for (const runId of new Set(steered)) await runChanged(pool, runId)
  }
}
