import { collaborationContext, failure, json } from '@/lib/issue-collaboration-route'
import { createIssueComment, listIssueComments } from '@/lib/issue-collaboration'

/**
 * GET  /api/issues/:code/comments — the task's comments, nested: top-level
 *      comments oldest first, each carrying its replies.
 * POST /api/issues/:code/comments — { body, replyTo?, files? }, exactly Capy's
 *      CommentIssueRequest (backlog/20261111/routes/issues.md). `replyTo` makes
 *      the new comment a reply to that comment of this task.
 */

export async function GET(request: Request, { params }: { params: Promise<{ code: string }> }) {
  try {
    const context = await collaborationContext(request, (await params).code)
    if (context instanceof Response) return context
    return json(await listIssueComments(context.issueId))
  } catch (error) { return failure(error) }
}

export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
  try {
    const context = await collaborationContext(request, (await params).code)
    if (context instanceof Response) return context
    let body: unknown
    try { body = await request.json() } catch { return json({ error: 'validationGeneric' }, 400) }
    const created = await createIssueComment(context.issueId, body as never)
    return json(created, 201)
  } catch (error) { return failure(error) }
}
