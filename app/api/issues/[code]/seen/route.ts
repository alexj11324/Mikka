import { collaborationContext, failure, json } from '@/lib/issue-collaboration-route'
import { markIssueSeen } from '@/lib/issue-collaboration'

/**
 * POST /api/issues/:code/seen — marks the task seen for the caller (Capy's
 * markSeen). Idempotent: looking twice only moves the time forward. The answer
 * carries the counters the page shows, so one visit refreshes both.
 */
export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
  try {
    const context = await collaborationContext(request, (await params).code)
    if (context instanceof Response) return context
    return json(await markIssueSeen(context.issueId))
  } catch (error) { return failure(error) }
}
