import { withDeviceRoute } from '@/lib/device-route'
import { after, NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { deviceHeartbeatSchema, isDeviceOnline } from '@mikka/protocol/device'
import { db, pool } from '@/lib/db'
import { ensureDeviceAgents } from '@/lib/device-agents'
import { authenticateDevice, linkDeviceToken } from '@/lib/device-link'
import { renewRunLeases } from '@/lib/run-leases'
import { SKILL_ARTIFACT_HEADER, TEAM_SKILL_HEADER } from '@mikka/protocol/skill'
import { skillAssignments } from '@/lib/self-improvement/server'
import { pendingDeviceCommands } from '@/lib/device-management'
import { renewCloudDeviceToken } from '@/lib/computer/cloud-device'
import { factoryLifecycleEnabled } from '@/lib/factory/runtime'
import { factoryDispatchRecovery } from '@/lib/factory/dispatch-recovery-server'
import { factoryDeviceOnline } from '@/lib/factory/dispatch-recovery'
import { daemonVersions } from '@/lib/daemon-release'

export const dynamic = 'force-dynamic'

/**
 * `POST /v1/devices/:deviceId/heartbeat`: online state and the harnesses the
 * device reports right now. The answer carries the renewed lease of each run
 * the device reports that is still claimed by it, and the runs it no longer
 * holds, which the daemon stops, and the daemon releases (it updates itself when idle).
 * Afterwards, runs the owner lost on another device are queued again, and
 * (Factory on) queued Factory runs this device could not take are marked re-dispatched once.
 */
async function handlePOST(request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { deviceId } = await params
  if (caller.removingDeviceId === deviceId) {
    const parsed = deviceHeartbeatSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) return NextResponse.json({ error: 'Invalid heartbeat.' }, { status: 400 })
    // No registration, harness refresh, run leases or other commands after removal.
    return NextResponse.json({ leases: {}, deviceCommands: await pendingDeviceCommands(deviceId, parsed.data.completedDeviceCommands ?? []) }, { headers: { 'Cache-Control': 'private, no-store' } })
  }
  // Also records this credential as the device's, so removing it revokes the credential.
  if (!await linkDeviceToken(caller, deviceId)) return NextResponse.json({ error: 'Unknown device.' }, { status: 404 })
  const parsed = deviceHeartbeatSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid heartbeat.' }, { status: 400 })
  const factoryOn = factoryLifecycleEnabled()
  const { harnesses, deviceType, updateFailure } = parsed.data
  const now = new Date()
  // One statement records the beat and returns what the device looked like before it.
  const { rows: [row] } = await db.execute<{ enabled: boolean; lastSeenAt: Date | string | null; harnessesChanged: boolean }>(sql`
    WITH prior AS (SELECT id, enabled, "lastSeenAt", harnesses FROM devices WHERE id=${deviceId} FOR UPDATE)
    UPDATE devices d SET "deviceType"=COALESCE(${deviceType ?? null}::text, d."deviceType"),
      "updateFailure"=CASE WHEN ${updateFailure !== undefined}::boolean THEN ${updateFailure == null ? null : JSON.stringify(updateFailure)}::jsonb ELSE d."updateFailure" END,
      harnesses=${JSON.stringify(harnesses)}::jsonb, "computerUse"=${JSON.stringify(parsed.data.computerUse ?? { installed: false, version: null })}::jsonb,
      "lastSeenAt"=${now.toISOString()}::timestamptz, "updatedAt"=${now.toISOString()}::timestamptz
    FROM prior WHERE d.id=prior.id
    RETURNING prior.enabled, prior."lastSeenAt", prior.harnesses IS DISTINCT FROM d.harnesses AS "harnessesChanged"`)
  const prior = row && { ...row, lastSeenAt: row.lastSeenAt === null ? null : new Date(row.lastSeenAt) }
  // The execution identities follow the harnesses: checked when they change or the
  // device comes back online (registration checks them too), not on every beat.
  if (prior && (prior.harnessesChanged || !isDeviceOnline(prior.lastSeenAt, now.getTime()))) await ensureDeviceAgents(pool, caller.userId, deviceId, harnesses)
  const runIds = parsed.data.runs.map(run => run.runId)
  // An idle device holds no leases: nothing to renew or revoke.
  const selected = runIds.length
    ? await skillAssignments.renewHeartbeat(caller.userId, deviceId, runIds, request.headers.get(SKILL_ARTIFACT_HEADER) === '1', request.headers.get(TEAM_SKILL_HEADER) === '1')
    : { legacy: [], leases: {}, revoked: [] }
  const result = await renewRunLeases(deviceId, selected.legacy)
  result.leases = { ...result.leases, ...selected.leases }
  result.revoked = [...new Set([...(result.revoked ?? []), ...selected.revoked])]
  const cloudCredential = caller.scopeDeviceId === deviceId && caller.scopeWorkspaceId
    ? await renewCloudDeviceToken(pool, { userId: caller.userId, workspaceId: caller.scopeWorkspaceId, deviceId, tokenId: caller.tokenId }).catch(() => null)
    : null
  if (factoryOn) after(() => factoryDispatchRecovery.deviceOnline(caller.userId, deviceId, !prior || !factoryDeviceOnline(prior)).catch((error: unknown) => console.error('Could not resume Factory dispatch', error instanceof Error ? error.message : error)))
  return NextResponse.json({ ...result, deviceCommands: await pendingDeviceCommands(deviceId, parsed.data.completedDeviceCommands ?? [], parsed.data.failedDeviceCommands ?? []), ...(cloudCredential ? { cloudCredential } : {}), daemonVersions: await daemonVersions() }, { headers: { 'Cache-Control': 'private, no-store' } })
}

export const POST = withDeviceRoute(handlePOST)
