import { pool } from '@/lib/db'
import { authenticateDevice } from '@/lib/device-link'
import { ThreadDesktopStore } from '@/lib/computer/thread-desktop'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** The trusted thread daemon asks for its own desktop just before the first
 * approved computer call. The task process never receives this credential. */
export async function POST(request: Request, { params }: { params: Promise<{ deviceId: string; runId: string }> }) {
  const caller = await authenticateDevice(request)
  const { deviceId, runId } = await params
  if (!caller || caller.scopeDeviceId !== deviceId || !caller.scopeWorkspaceId) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  const thread = await pool.query(`SELECT 1 FROM thread_machines t JOIN agent_runs r ON r.id=t."runId" AND r."deviceId"=t."deviceId"
    WHERE t."runId"=$1 AND t."deviceId"=$2 AND t."workspaceId"=$3 AND t."ownerId"=$4`, [runId, deviceId, caller.scopeWorkspaceId, caller.userId])
  if (!thread.rowCount) return Response.json({ error: 'Thread unavailable' }, { status: 404 })
  try {
    await new ThreadDesktopStore(pool).operate({ userId: caller.userId, workspaceId: caller.scopeWorkspaceId }, runId, 'wake')
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })
  } catch { return Response.json({ error: 'Thread computer unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }) }
}
