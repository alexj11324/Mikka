import { withDeviceRoute } from '@/lib/device-route'
import { after, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { deviceHeartbeatSchema } from '@mikka/protocol/device'
import { db, pool } from '@/lib/db'
import { ensureDeviceAgents } from '@/lib/device-agents'
import { devices } from '@/lib/db/schema'
import { authenticateDevice, linkDeviceToken } from '@/lib/device-link'
import { reclaimLostRuns, renewRunLeases } from '@/lib/run-leases'
import { SKILL_ARTIFACT_HEADER } from '@mikka/protocol/skill'
import { skillAssignments } from '@/lib/self-improvement/server'
import { pendingDeviceCommands } from '@/lib/device-management'
import { renewCloudDeviceToken } from '@/lib/computer/cloud-device'
import { factoryLifecycleEnabled } from '@/lib/factory/runtime'
import { factoryDispatchRecovery } from '@/lib/factory/dispatch-recovery-server'
import { factoryDeviceOnline } from '@/lib/factory/dispatch-recovery'

export const dynamic = 'force-dynamic'

/**
 * `POST /v1/devices/:deviceId/heartbeat`: online state and the harnesses the
 * device reports right now. The answer carries the renewed lease of each run
 * the device reports that is still claimed by it, and the runs it no longer
 * holds, which the daemon stops.
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
  const [prior] = factoryOn ? await db.select({ enabled: devices.enabled, lastSeenAt: devices.lastSeenAt, harnesses: devices.harnesses }).from(devices).where(eq(devices.id, deviceId)).limit(1) : []
  await db.update(devices).set({ ...(parsed.data.deviceType ? { deviceType: parsed.data.deviceType } : {}), harnesses: parsed.data.harnesses, computerUse: parsed.data.computerUse ?? { installed: false, version: null }, lastSeenAt: new Date(), updatedAt: new Date() }).where(eq(devices.id, deviceId))
  await ensureDeviceAgents(pool, caller.userId, deviceId, parsed.data.harnesses)
  const selected=await skillAssignments.renewHeartbeat(caller.userId,deviceId,parsed.data.runs.map(run=>run.runId),request.headers.get(SKILL_ARTIFACT_HEADER)==='1')
  const result=await renewRunLeases(deviceId,selected.legacy)
  result.leases={...result.leases,...selected.leases}
  result.revoked=[...new Set([...(result.revoked??[]),...selected.revoked])]
  const cloudCredential = caller.scopeDeviceId === deviceId && caller.scopeWorkspaceId
    ? await renewCloudDeviceToken(pool, { userId: caller.userId, workspaceId: caller.scopeWorkspaceId, deviceId, tokenId: caller.tokenId }).catch(() => null)
    : null
  if (factoryOn) after(() => factoryDispatchRecovery.deviceOnline(caller.userId, deviceId, !prior || !factoryDeviceOnline(prior)).catch((error: unknown) => console.error('Could not resume Factory dispatch', error instanceof Error ? error.message : error)))
  after(() => reclaimLostRuns(caller.userId).catch((error: unknown) => console.error('Could not reclaim lost runs', error instanceof Error ? error.message : error)))
  return NextResponse.json({ ...result, deviceCommands: await pendingDeviceCommands(deviceId, parsed.data.completedDeviceCommands ?? [], parsed.data.failedDeviceCommands ?? []), ...(cloudCredential ? { cloudCredential } : {}) }, { headers: { 'Cache-Control': 'private, no-store' } })
}

export const POST = withDeviceRoute(handlePOST)
