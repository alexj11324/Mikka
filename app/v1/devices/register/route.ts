import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { deviceRegistration } from '@orvilo/protocol/device'
import { db } from '@/lib/db'
import { devices } from '@/lib/db/schema'
import { authenticateDevice, ownedDevice, WORKSPACE_ID } from '@/lib/device-link'

export const dynamic = 'force-dynamic'

/**
 * `POST /v1/devices/register`: the daemon's first call, and its re-register
 * after a restart. A `deviceId` the caller already owns keeps that id, so the
 * runs pinned to it survive; any other id becomes a new device.
 */
export async function POST(request: Request) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const parsed = deviceRegistration.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid registration.' }, { status: 400 })
  const info = parsed.data
  const now = new Date()
  const fields = {
    name: info.name, hostname: info.hostname ?? null, platform: info.platform, arch: info.arch,
    daemonVersion: info.daemonVersion, protocolVersion: info.protocolVersion,
    harnesses: info.harnesses, lastSeenAt: now, updatedAt: now,
  }
  if (info.deviceId && await ownedDevice(info.deviceId, caller.userId)) {
    await db.update(devices).set(fields).where(eq(devices.id, info.deviceId))
    return NextResponse.json({ deviceId: info.deviceId, workspaceId: WORKSPACE_ID })
  }
  const deviceId = crypto.randomUUID()
  await db.insert(devices).values({ id: deviceId, ownerId: caller.userId, ...fields })
  return NextResponse.json({ deviceId, workspaceId: WORKSPACE_ID })
}
