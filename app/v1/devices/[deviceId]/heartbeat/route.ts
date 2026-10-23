import { NextResponse } from 'next/server'
import { deviceHeartbeatSchema } from '@mikka/protocol/device'
import { db } from '@/lib/db'
import { authenticateDevice, ownedDevice } from '@/lib/device-link'
import { recordDeviceHeartbeat } from '@/lib/run-leases'

export const dynamic = 'force-dynamic'

/**
 * `POST /v1/devices/:deviceId/heartbeat`: online state and the harnesses the
 * device reports right now. Renews the runs the daemon reported (if on this
 * device and unfinished) to now + RUN_LEASE_MS and answers with those leases.
 */
export async function POST(request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { deviceId } = await params
  if (!await ownedDevice(deviceId, caller.userId)) return NextResponse.json({ error: 'Unknown device.' }, { status: 404 })
  const parsed = deviceHeartbeatSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid heartbeat.' }, { status: 400 })
  const leases = await recordDeviceHeartbeat(db, deviceId, parsed.data.harnesses, parsed.data.runs.map(run => run.runId))
  return NextResponse.json({ leases })
}
