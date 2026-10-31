import { withDeviceRoute } from '@/lib/device-route'
import { NextResponse } from 'next/server'
import { runCommandsAck } from '@mikka/protocol/device'
import { ackCommands, authenticateDevice, ownedDevice } from '@/lib/device-link'

export const dynamic = 'force-dynamic'

/** `POST /v1/devices/:deviceId/commands/ack`: messages the agent now holds. */
async function handlePOST(request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { deviceId } = await params
  if (!await ownedDevice(deviceId, caller.userId)) return NextResponse.json({ error: 'Unknown device.' }, { status: 404 })
  const parsed = runCommandsAck.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid ack.' }, { status: 400 })
  await ackCommands(deviceId, parsed.data.delivered)
  return new NextResponse(null, { status: 204 })
}

export const POST = withDeviceRoute(handlePOST)
