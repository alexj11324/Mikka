import { withDeviceRoute } from '@/lib/device-route'
import { NextResponse } from 'next/server'
import type { DeviceGatewayTicket } from '@mikka/protocol/device'
import { authenticateDevice, ownsDevice } from '@/lib/device-link'
import { deviceGatewayTicket } from '@/lib/device-gateway-ticket'
import { gatewayConfig, gatewayURL } from '@/lib/builtin-gateway/config'
import { pool } from '@/lib/db'

export const dynamic = 'force-dynamic'

const headers = { 'Cache-Control': 'private, no-store' }

/**
 * `GET /v1/devices/:deviceId/gateway`: the ticket for this device's session
 * socket (decision 2026-11-17-2215). The socket is the device's session: work,
 * run controls, computer reviews and Coordinator tool results are pushed over
 * it, and the device is online only while it is open. A server without a
 * gateway answers 503 `deviceGatewayRequired`: it has no devices, and there is
 * no long-poll fallback. The ticket is checked by the gateway; this route does
 * not wait. A cloud worker also learns when its token expires, so it can ask
 * for the next one an hour before (POST .../report `rotateCloudCredential`).
 */
async function handleGET(request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers })
  const { deviceId } = await params
  if (!await ownsDevice(deviceId, caller.userId)) return NextResponse.json({ error: 'Unknown device.' }, { status: 404, headers })
  const config = gatewayConfig()
  if (!config) return NextResponse.json({ error: 'device_gateway_required', code: 'deviceGatewayRequired' }, { status: 503, headers })
  const url = gatewayURL(config, `/v1/devices/${encodeURIComponent(deviceId)}/socket`)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.search = ''
  const { protocol } = deviceGatewayTicket(deviceId, config.secret)
  const ticket: DeviceGatewayTicket = { url: url.toString(), protocol }
  if (caller.scopeDeviceId === deviceId && caller.scopeWorkspaceId) {
    const { rows: [token] } = await pool.query<{ expiresAt: Date | null }>(`SELECT "expiresAt" FROM device_tokens WHERE id=$1`, [caller.tokenId])
    if (token?.expiresAt) ticket.cloudCredentialExpiresAt = token.expiresAt.toISOString()
  }
  return NextResponse.json(ticket, { headers })
}

export const GET = withDeviceRoute(handleGET)
