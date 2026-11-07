import { withDeviceRoute } from '@/lib/device-route'
import { NextResponse } from 'next/server'
import { authenticateDevice, ownsDevice } from '@/lib/device-link'
import { deviceGatewayTicket } from '@/lib/device-gateway-ticket'
import { gatewayConfig, gatewayURL } from '@/lib/builtin-gateway/config'

export const dynamic = 'force-dynamic'

/** The waits this server pushes for (packages/protocol deviceGatewaySchema). */
const PUSHED = { runControl: 'push', computerReviews: 'push', coordinatorResults: 'push' } as const

/**
 * `GET /v1/devices/:deviceId/gateway`: one ticket for this device's push socket.
 * Null when the gateway is not configured; the daemon keeps long-polling.
 * The ticket is checked by the gateway. This route does not open a database wait.
 */
async function handleGET(request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { deviceId } = await params
  if (!await ownsDevice(deviceId, caller.userId)) return NextResponse.json({ error: 'Unknown device.' }, { status: 404 })
  const config = gatewayConfig()
  // runControl: every write that ends, pauses or revokes a run wakes its device
  // (notifyRunControl), so a connected daemon drops its periodic check (#1212).
  // computerReviews: a web decision on a computer review wakes its device
  // (decideComputerReview), so the daemon stops syncing reviews every second.
  // coordinatorResults: a native Coordinator tool result wakes its device (finishTool).
  if (!config) return NextResponse.json({ url: null, protocol: null, ...PUSHED })
  const url = gatewayURL(config, `/v1/devices/${encodeURIComponent(deviceId)}/socket`)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.search = ''
  const { protocol } = deviceGatewayTicket(deviceId, config.secret)
  return NextResponse.json({ url: url.toString(), protocol, ...PUSHED }, { headers: { 'Cache-Control': 'private, no-store' } })
}

export const GET = withDeviceRoute(handleGET)
