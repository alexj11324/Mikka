import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { deviceHeartbeatSchema } from '@mikka/protocol/device'
import { db } from '@/lib/db'
import { devices } from '@/lib/db/schema'
import { authenticateDevice, ownedDevice } from '@/lib/device-link'

export const dynamic = 'force-dynamic'

/**
 * `POST /v1/devices/:deviceId/heartbeat`: online state and the harnesses the
 * device reports right now. The answer carries renewed run leases; this app
 * runs no lease-based scheduling yet, so it is empty.
 */
export async function POST(request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { deviceId } = await params
  if (!await ownedDevice(deviceId, caller.userId)) return NextResponse.json({ error: 'Unknown device.' }, { status: 404 })
  const parsed = deviceHeartbeatSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid heartbeat.' }, { status: 400 })
  await db.update(devices).set({ harnesses: parsed.data.harnesses, lastSeenAt: new Date(), updatedAt: new Date() }).where(eq(devices.id, deviceId))
  return NextResponse.json({ leases: {} })
}
