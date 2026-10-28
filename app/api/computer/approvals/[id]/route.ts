import { z } from 'zod'
import { approvalDecisionSchema } from '@mikka/protocol/computer'
import { auth } from '@/lib/auth'
import { pool } from '@/lib/db'
import { loadWorkspaceContext } from '@/lib/workspace-access'
import { decideComputerReview } from '@/lib/computer/reviews'
const headers = { 'Cache-Control': 'private, no-store' }
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return Response.json({ error: 'Sign in required' }, { status: 401, headers })
  if (request.headers.get('origin') !== new URL(request.url).origin) return Response.json({ error: 'Invalid origin' }, { status: 403, headers })
  const { id } = await params
  if (!z.uuid().safeParse(id).success) return Response.json({ error: 'Invalid request' }, { status: 400, headers })
  const body = await request.text()
  if (body.length > 2000) return Response.json({ error: 'Invalid request' }, { status: 400, headers })
  const parsed = approvalDecisionSchema.safeParse((() => { try { return JSON.parse(body) } catch { return null } })())
  if (!parsed.success) return Response.json({ error: 'Invalid request' }, { status: 400, headers })
  if (parsed.data.scope === 'run' && parsed.data.decision !== 'approve') return Response.json({ error: 'Invalid request' }, { status: 400, headers })
  try {
    const context = await loadWorkspaceContext(undefined, session.user)
    const queued = await decideComputerReview(pool, { userId: session.user.id, workspaceId: context.workspace.id }, id, parsed.data.digest, parsed.data.decision === 'approve', parsed.data.scope)
    return queued ? Response.json({ queued: true }, { headers }) : Response.json({ error: 'Review unavailable' }, { status: 409, headers })
  } catch { return Response.json({ error: 'Review unavailable' }, { status: 503, headers }) }
}
