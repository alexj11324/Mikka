import { z } from 'zod'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { threadResultDownload } from '@/lib/computer/thread-result-download'

export const runtime = 'nodejs'
export const maxDuration = 300

export async function GET(request: Request, context: { params: Promise<{ runId: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return Response.json({ error: 'Sign in required' }, { status: 401 })
  const { runId } = await context.params
  if (!z.uuid().safeParse(runId).success) return Response.json({ error: 'Invalid thread' }, { status: 400 })
  const workspace = await loadWorkspaceContext(undefined, session.user)
  try {
    const stream = await threadResultDownload(pool, { userId: session.user.id, workspaceId: workspace.workspace.id }, runId)
    if (!stream) return Response.json({ error: 'Thread result not available' }, { status: 404 })
    return new Response(stream, { headers: { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="thread-${runId}.tar.gz"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } })
  } catch { return Response.json({ error: 'Thread result is unavailable' }, { status: 503 }) }
}
