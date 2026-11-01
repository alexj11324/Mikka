import { cloudComputerTasksEnabled } from '@/lib/cloud-computer-flag'
import { z } from 'zod'
import { auth } from '@/lib/api-auth'
import { pool } from '@/lib/db'
import { loadWorkspaceContext } from '@/lib/workspace-access'

const headers = { 'Cache-Control': 'private, no-store' }
export async function GET(request: Request, { params }: { params: Promise<{ botId: string }> }) {
  if (!cloudComputerTasksEnabled()) return Response.json({ error: 'Cloud computer task unavailable' }, { status: 503, headers })
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return Response.json({ error: 'Sign in required' }, { status: 401, headers })
  const { botId } = await params
  if (!z.uuid().safeParse(botId).success) return Response.json({ error: 'Invalid request' }, { status: 400, headers })
  try {
    const context = await loadWorkspaceContext(undefined, session.user)
    const bot = await pool.query('SELECT 1 FROM bots WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3', [botId, session.user.id, context.workspace.id])
    if (!bot.rowCount) return Response.json({ error: 'Computer not found' }, { status: 404, headers })
    const result = await pool.query('SELECT harness,"agentId","repoId" FROM bot_cloud_runtimes WHERE "botId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 ORDER BY harness', [botId, session.user.id, context.workspace.id])
    return Response.json({ runtimes: result.rows }, { headers })
  } catch { return Response.json({ error: 'Cloud computer task unavailable' }, { status: 503, headers }) }
}
