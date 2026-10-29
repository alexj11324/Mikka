import { after, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { deviceHeartbeatSchema } from '@mikka/protocol/device'
import { db, pool } from '@/lib/db'
import { ensureDeviceAgents } from '@/lib/device-agents'
import { devices } from '@/lib/db/schema'
import { authenticateDevice, ownedDevice } from '@/lib/device-link'
import { reclaimLostRuns, renewRunLeases } from '@/lib/run-leases'
import { renewCloudDeviceToken } from '@/lib/computer/cloud-device'

export const dynamic = 'force-dynamic'

/**
 * `POST /v1/devices/:deviceId/heartbeat`: online state and the harnesses the
 * device reports right now. The answer carries the renewed lease of each run
 * the device reports that is still claimed by it, and the runs it no longer
 * holds, which the daemon stops.
 * Afterwards, runs the owner lost on another device are queued again.
 */
export async function POST(request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { deviceId } = await params
  if (!await ownedDevice(deviceId, caller.userId)) return NextResponse.json({ error: 'Unknown device.' }, { status: 404 })
  const parsed = deviceHeartbeatSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid heartbeat.' }, { status: 400 })
  await db.update(devices).set({ harnesses: parsed.data.harnesses, computerUse: parsed.data.computerUse ?? { installed: false, version: null }, lastSeenAt: new Date(), updatedAt: new Date() }).where(eq(devices.id, deviceId))
  await ensureDeviceAgents(pool, caller.userId, deviceId, parsed.data.harnesses)
  const result = await renewRunLeases(deviceId, parsed.data.runs.map(run => run.runId))
  const cloudCredential = caller.scopeDeviceId === deviceId && caller.scopeWorkspaceId
    ? await renewCloudDeviceToken(pool, { userId: caller.userId, workspaceId: caller.scopeWorkspaceId, deviceId, tokenId: caller.tokenId }).catch(() => null)
    : null
  after(() => reclaimLostRuns(caller.userId).catch((error: unknown) => console.error('Could not reclaim lost runs', error instanceof Error ? error.message : error)))
  return NextResponse.json({ ...result, ...(cloudCredential ? { cloudCredential } : {}) }, { headers: { 'Cache-Control': 'private, no-store' } })
}
