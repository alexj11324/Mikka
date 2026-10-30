import { withDeviceRoute } from '@/lib/device-route'
import { NextResponse } from 'next/server'
import { authenticateDevice, ownedDevice } from '@/lib/device-link'

export const dynamic = 'force-dynamic'

/** `POST /v1/devices/:deviceId/fs/requests/:requestId`: the daemon's answer. */
async function handlePOST(request: Request, { params }: { params: Promise<{ deviceId: string; requestId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { deviceId } = await params
  if (!await ownedDevice(deviceId, caller.userId)) return NextResponse.json({ error: 'Unknown device.' }, { status: 404 })
  return new NextResponse(null, { status: 204 })
}

export const POST = withDeviceRoute(handlePOST)
