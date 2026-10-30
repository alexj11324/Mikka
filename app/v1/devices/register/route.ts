import { withDeviceRoute } from '@/lib/device-route'
import { NextResponse } from 'next/server'
import { eq, sql } from 'drizzle-orm'
import { deviceRegistration } from '@mikka/protocol/device'
import { db, pool } from '@/lib/db'
import { ensureDeviceAgents } from '@/lib/device-agents'
import { devices } from '@/lib/db/schema'
import { authenticateDevice, linkDeviceToken, WORKSPACE_ID } from '@/lib/device-link'

export const dynamic = 'force-dynamic'

/**
 * `POST /v1/devices/register`: the daemon's first call, and its re-register
 * after a restart. A `deviceId` the caller already owns keeps that id, so the
 * runs pinned to it survive; any other id, including a device the person
 * removed in settings, becomes a new device. The credential is recorded as
 * the device's, so removing the device revokes it.
 */
async function handlePOST(request: Request) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const parsed = deviceRegistration.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid registration.' }, { status: 400 })
  const info = parsed.data
  const now = new Date()
  const fields = {
    deviceType: info.deviceType ?? 'laptop',
    hostname: info.hostname ?? null, platform: info.platform, arch: info.arch,
    daemonVersion: info.daemonVersion, protocolVersion: info.protocolVersion,
    computerUse: info.computerUse ?? { installed: false, version: null },
    harnesses: info.harnesses, lastSeenAt: now, updatedAt: now,
  }
  if (info.deviceId && await linkDeviceToken(caller, info.deviceId)) {
    // A name the person chose in settings outlives the daemon's hostname.
    await db.update(devices).set({ ...fields, name: sql`CASE WHEN ${devices.nameLocked} THEN ${devices.name} ELSE ${info.name} END` }).where(eq(devices.id, info.deviceId))
    await ensureDeviceAgents(pool, caller.userId, info.deviceId, info.harnesses)
    return NextResponse.json({ deviceId: info.deviceId, workspaceId: caller.scopeWorkspaceId ?? WORKSPACE_ID })
  }
  if (caller.scopeDeviceId) return NextResponse.json({ error: 'Cloud device is unavailable.' }, { status: 403 })
  const deviceId = crypto.randomUUID()
  await db.insert(devices).values({ id: deviceId, ownerId: caller.userId, name: info.name, ...fields })
  await linkDeviceToken(caller, deviceId)
  await ensureDeviceAgents(pool, caller.userId, deviceId, info.harnesses)
  return NextResponse.json({ deviceId, workspaceId: caller.scopeWorkspaceId ?? WORKSPACE_ID })
}

export const POST = withDeviceRoute(handlePOST)
