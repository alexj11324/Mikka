import { withDeviceRoute } from '@/lib/device-route'
import { NextResponse } from 'next/server'
import { authenticateDevice, ownedDevice } from '@/lib/device-link'

export const dynamic = 'force-dynamic'

/**
 * `GET /v1/devices/:deviceId/fs/requests`: folder-browse requests queued for
 * this device. This app adds repositories by path, so the answer is always
 * empty and there is nothing to wait for.
 */
async function handleGET(request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { deviceId } = await params
  if (!await ownedDevice(deviceId, caller.userId)) return NextResponse.json({ error: 'Unknown device.' }, { status: 404 })
  return NextResponse.json({ requests: [] })
}

export const GET = withDeviceRoute(handleGET)
