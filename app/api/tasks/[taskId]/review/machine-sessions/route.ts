import { ReviewAuthorityError, withTaskReviewAuthority } from '@/lib/coding-workspace/review-authority'
import { readReviewSession, type ReviewSessionKind } from '@/lib/coding-workspace/review-sessions'

export const maxDuration = 30

const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
const json = (body: unknown, status = 200) => Response.json(body, { status, headers })

export async function GET(request: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params
  try {
    return await withTaskReviewAuthority(request, taskId, async (authority, client) => {
      if (new URL(request.url).search) return json({ error: 'invalid_request' }, 400)
      if (authority.machineKind !== 'cloud') return json({ error: 'workspace_unsupported' }, 422)
      const sessions: { kind: ReviewSessionKind; expiresAt: string }[] = []
      for (const kind of ['terminal', 'preview'] as const) {
        const lease = await readReviewSession(authority, { kind }, client)
        if (lease) sessions.push({ kind, expiresAt: lease.expiresAt })
      }
      return json({ runId: authority.runId, sessions })
    })
  } catch (error) {
    if (error instanceof ReviewAuthorityError) return json({ error: error.code }, error.status)
    throw error
  }
}
