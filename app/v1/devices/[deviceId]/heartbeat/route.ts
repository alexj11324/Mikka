import { CLIENT_VERSION_HEADER } from '@mikka/protocol/version'
import { withDeviceRoute } from '@/lib/device-route'
import { NextResponse } from 'next/server'
import { afterJob } from '@/lib/background'
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
import { daemonVersions, daemonRequestTooOld } from '@/lib/daemon-release'
import { ownerListChanged } from '@/lib/live/lists'
import { renewTaskSecretAccess } from '@/lib/secrets/task-renewal'
import { withBasePath } from '@/lib/base-path'
import { TASK_SECRETS_HEADER, TASK_SECRETS_VERSION } from '@mikka/protocol/task-secrets'
import { withDeviceHeartbeatBody } from '@/lib/device-heartbeat-body'

export const dynamic = 'force-dynamic'

/**
 * `POST /v1/devices/:deviceId/heartbeat`: online state and the harnesses the
 * device reports right now. The answer carries the renewed lease of each run
 * the device reports that is still claimed by it, and the runs it no longer
 * holds, which the daemon stops, and the daemon releases (it updates itself when idle).
 * Afterwards, runs the owner lost on another device are queued again, and
 * (Factory on) queued Factory runs this device could not take are marked re-dispatched once.
 */
async function handlePOST(request: Request, body: unknown, { params }: { params: Promise<{ deviceId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { deviceId } = await params
  if (caller.removingDeviceId === deviceId) {
    const parsed = deviceHeartbeatSchema.safeParse(body)
    if (!parsed.success) return NextResponse.json({ error: 'Invalid heartbeat.' }, { status: 400 })
    // No registration, harness refresh, run leases or other commands after removal.
    return NextResponse.json({ leases: {}, deviceCommands: await pendingDeviceCommands(deviceId, parsed.data.completedDeviceCommands ?? []) }, { headers: { 'Cache-Control': 'private, no-store' } })
  }
  // Also records this credential as the device's, so removing it revokes the credential.
  if (!await linkDeviceToken(caller, deviceId)) return NextResponse.json({ error: 'Unknown device.' }, { status: 404 })
  const parsed = deviceHeartbeatSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid heartbeat.' }, { status: 400 })
  if (daemonRequestTooOld(request.headers.get(CLIENT_VERSION_HEADER), Boolean(caller.scopeDeviceId && caller.scopeWorkspaceId))) {
    // No harness provisioning, task dispatch or new Skill work while obsolete.
    // Only renew work held by this original claim credential during its update.
    const reported = parsed.data.runs.map(run => run.runId)
    const owned = reported.length ? await pool.query<{ id: string }>(`SELECT id FROM agent_runs WHERE "deviceTokenId"=$1 AND "userId"=$2
      AND "deviceId"=$3 AND id::text=ANY($4::text[]) AND "leaseExpiresAt">now()
      AND status IN ('preparing','running','waiting_input','finishing')`, [caller.tokenId, caller.userId, deviceId, reported]) : { rows: [] }
    const ids = owned.rows.map(run => run.id)
    const selected = ids.length ? await skillAssignments.renewHeartbeat(caller.userId, deviceId, ids, request.headers.get(SKILL_ARTIFACT_HEADER) === '1', request.headers.get(TEAM_SKILL_HEADER) === '1') : { legacy: [], leases: {}, revoked: [] }
    const result = await renewRunLeases(deviceId, selected.legacy)
    result.leases = { ...result.leases, ...selected.leases }
    const renewedSecrets = request.headers.get(TASK_SECRETS_HEADER) === TASK_SECRETS_VERSION
      ? await renewTaskSecretAccess({ caller, deviceId, runs: parsed.data.runs, leases: result.leases,
        endpoint: runId => new URL(withBasePath(`/v1/task-secrets/${runId}`), request.url).toString() })
      : { taskSecrets: {}, revoked: [] }
    for (const runId of renewedSecrets.revoked) delete result.leases[runId]
    const deviceCommands = (await pendingDeviceCommands(deviceId, parsed.data.completedDeviceCommands ?? [], parsed.data.failedDeviceCommands ?? [])).filter(command => command.kind === 'update' || command.kind === 'restart')
    return NextResponse.json({ ...result, ...(Object.keys(renewedSecrets.taskSecrets).length ? { taskSecrets: renewedSecrets.taskSecrets } : {}), revoked: [...new Set([...(result.revoked ?? []), ...selected.revoked, ...renewedSecrets.revoked, ...reported.filter(id => !ids.includes(id))])], deviceCommands, daemonVersions: await daemonVersions() }, { headers: { 'Cache-Control': 'private, no-store' } })
  }
  const factoryOn = factoryLifecycleEnabled()
  const { harnesses, deviceType, updateFailure } = parsed.data
  const now = new Date()
  // One statement records the beat and returns what the device looked like before it.
  // The harnesses are stored only once their execution identities exist (below), so a
  // failed check leaves them changed for the next beat, which checks again.
  const { rows: [row] } = await db.execute<{ enabled: boolean; lastSeenAt: Date | string | null; harnessesChanged: boolean }>(sql`
    WITH prior AS (SELECT id, enabled, "lastSeenAt", harnesses FROM devices WHERE id=${deviceId} FOR UPDATE)
    UPDATE devices d SET "deviceType"=COALESCE(${deviceType ?? null}::text, d."deviceType"),
      "updateFailure"=CASE WHEN ${updateFailure !== undefined}::boolean THEN ${updateFailure == null ? null : JSON.stringify(updateFailure)}::jsonb ELSE d."updateFailure" END,
      "computerUse"=${JSON.stringify(parsed.data.computerUse ?? { installed: false, version: null })}::jsonb,
      "lastSeenAt"=${now.toISOString()}::timestamptz, "updatedAt"=${now.toISOString()}::timestamptz
    FROM prior WHERE d.id=prior.id
    RETURNING prior.enabled, prior."lastSeenAt", prior.harnesses IS DISTINCT FROM ${JSON.stringify(harnesses)}::jsonb AS "harnessesChanged"`)
  const prior = row && { ...row, lastSeenAt: row.lastSeenAt === null ? null : new Date(row.lastSeenAt) }
  // The execution identities follow the harnesses: checked when they change or the
  // device comes back online (registration checks them too), not on every beat.
  if (prior && (prior.harnessesChanged || !isDeviceOnline(prior.lastSeenAt, now.getTime()))) await ensureDeviceAgents(pool, caller.userId, deviceId, harnesses, { reported: true })
  if (prior?.harnessesChanged) await db.execute(sql`UPDATE devices SET harnesses=${JSON.stringify(harnesses)}::jsonb WHERE id=${deviceId}`)
  // The device list shows presence and harnesses: an ordinary beat changes neither, coming back online or a new harness does.
  if (prior && (prior.harnessesChanged || !isDeviceOnline(prior.lastSeenAt, now.getTime()))) await ownerListChanged(db, caller.userId, ['device_list'])
  const runIds = parsed.data.runs.map(run => run.runId)
  // An idle device holds no leases: nothing to renew or revoke.
  const selected = runIds.length
    ? await skillAssignments.renewHeartbeat(caller.userId, deviceId, runIds, request.headers.get(SKILL_ARTIFACT_HEADER) === '1', request.headers.get(TEAM_SKILL_HEADER) === '1')
    : { legacy: [], leases: {}, revoked: [] }
  const result = await renewRunLeases(deviceId, selected.legacy)
  result.leases = { ...result.leases, ...selected.leases }
  result.revoked = [...new Set([...(result.revoked ?? []), ...selected.revoked])]
  const renewedSecrets = request.headers.get(TASK_SECRETS_HEADER) === TASK_SECRETS_VERSION
    ? await renewTaskSecretAccess({ caller, deviceId, runs: parsed.data.runs, leases: result.leases,
      endpoint: runId => new URL(withBasePath(`/v1/task-secrets/${runId}`), request.url).toString() }, now)
    : { taskSecrets: {}, revoked: [] }
  for (const runId of renewedSecrets.revoked) delete result.leases[runId]
  result.revoked = [...new Set([...result.revoked, ...renewedSecrets.revoked])]
  const cloudCredential = caller.scopeDeviceId === deviceId && caller.scopeWorkspaceId
    ? await renewCloudDeviceToken(pool, { userId: caller.userId, workspaceId: caller.scopeWorkspaceId, deviceId, tokenId: caller.tokenId }).catch(() => null)
    : null
  if (factoryOn) afterJob('after:factory-dispatch-recovery', () => factoryDispatchRecovery.deviceOnline(caller.userId, deviceId, !prior || !factoryDeviceOnline(prior)).catch((error: unknown) => console.error('Could not resume Factory dispatch', error instanceof Error ? error.message : error)))
  return NextResponse.json({ ...result, ...(Object.keys(renewedSecrets.taskSecrets).length ? { taskSecrets: renewedSecrets.taskSecrets } : {}), deviceCommands: await pendingDeviceCommands(deviceId, parsed.data.completedDeviceCommands ?? [], parsed.data.failedDeviceCommands ?? []), ...(cloudCredential ? { cloudCredential } : {}), daemonVersions: await daemonVersions() }, { headers: { 'Cache-Control': 'private, no-store' } })
}

export const POST = withDeviceHeartbeatBody(withDeviceRoute(handlePOST))
