import { authenticateDevice } from '@/lib/device-link'
import { pool } from '@/lib/db'
import { localComputerAuthority } from '@/lib/computer/local-authority'
export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'private, no-store' }
export async function GET(request: Request, { params }: { params: Promise<{ deviceId: string; runId: string }> }) {
  const actor = await authenticateDevice(request)
  if (!actor) return Response.json({ error: 'Unauthorized' }, { status: 401, headers })
  const { deviceId, runId } = await params
  if ((actor.scopeDeviceId && actor.scopeDeviceId !== deviceId) || !/^[0-9a-f-]{36}$/i.test(deviceId) || !/^[0-9a-f-]{36}$/i.test(runId)) return Response.json({ error: 'Unavailable' }, { status: 404, headers })
  const authority = await localComputerAuthority(pool, actor.userId, deviceId, runId)
  if (!authority || (actor.scopeWorkspaceId && actor.scopeWorkspaceId !== authority.workspaceId)) return Response.json({ error: 'Unavailable' }, { status: 409, headers })
  return Response.json(authority, { headers })
}
