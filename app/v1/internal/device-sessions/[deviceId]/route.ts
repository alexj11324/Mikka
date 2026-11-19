import { deviceSessionReportSchema } from '@mikka/protocol/device'
import { z } from 'zod'
import { verifyBearer } from '@/lib/cron-auth'
import { gatewayConfig } from '@/lib/builtin-gateway/config'
import { applyDeviceSessionReport } from '@/lib/device-session'


const headers = { 'Cache-Control': 'no-store' }
const MAX_BODY_BYTES = 1024

/**
 * `POST /v1/internal/device-sessions/:deviceId`: the device gateway reports a
 * device socket that opened (`connected`) or closed (`disconnected`), with
 * `Authorization: Bearer <DEVICE_GATEWAY_PUSH_SECRET>` (decision 2026-11-17-2215).
 * The gateway retries a report until it gets 204, so an unknown or removed
 * device also gets 204: there is nothing to retry.
 */
export async function POST(request: Request, { params }: { params: Promise<{ deviceId: string }> }): Promise<Response> {
  const config = gatewayConfig()
  if (!config || !await verifyBearer(request.headers.get('authorization'), config.secret)) return new Response(null, { status: 401, headers })
  const { deviceId } = await params
  const text = await request.text().catch(() => null)
  if (text === null || text.length > MAX_BODY_BYTES) return Response.json({ error: 'invalidSessionReport' }, { status: 400, headers })
  let body: unknown
  try { body = JSON.parse(text) } catch { return Response.json({ error: 'invalidSessionReport' }, { status: 400, headers }) }
  const report = deviceSessionReportSchema.safeParse(body)
  if (!report.success) return Response.json({ error: 'invalidSessionReport' }, { status: 400, headers })
  if (!z.uuid().safeParse(deviceId).success) return new Response(null, { status: 204, headers })
  await applyDeviceSessionReport(deviceId, report.data)
  return new Response(null, { status: 204, headers })
}
