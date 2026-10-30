import { computerSyncBody } from '@mikka/protocol/computer'
import { authenticateDevice, ownedDevice } from '@/lib/device-link'
import { pool } from '@/lib/db'
import { syncComputerReviews } from '@/lib/computer/reviews'
import { syncLocalComputerReviews } from '@/lib/computer/local-reviews'
import { workspaceSecretMasker } from '@/lib/secrets/runtime'
export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store' }
export async function POST(request: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const caller = await authenticateDevice(request)
  if (!caller) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
  const { deviceId } = await params
  if (caller.scopeDeviceId && caller.scopeDeviceId !== deviceId) return Response.json({ error: 'Unknown device' }, { status: 404, headers })
  const device = await ownedDevice(deviceId, caller.userId)
  if (!device?.enabled) return Response.json({ error: 'Unknown device' }, { status: 404, headers })
  const body = await request.text()
  if (body.length > 200000) return Response.json({ error: 'Too large' }, { status: 413, headers })
  const parsed = computerSyncBody.safeParse((() => { try { return JSON.parse(body) } catch { return null } })())
  if (!parsed.success) return Response.json({ error: 'Invalid snapshot' }, { status: 400, headers })
  try { return Response.json({ decisions: await (device.kind === 'local' ? syncLocalComputerReviews : syncComputerReviews)(pool, deviceId, caller.userId, parsed.data.requests, await workspaceSecretMasker(caller.scopeWorkspaceId)) }, { headers }) }
  catch { return Response.json({ error: 'Review or run unavailable' }, { status: 409, headers }) }
}
