import { collaborationContext, failure, json } from '@/lib/issue-collaboration-route'
import { addIssueLink, listIssueLinks, removeIssueLink } from '@/lib/issue-collaboration'

/**
 * GET    /api/issues/:code/links — the task's external references.
 * POST   /api/issues/:code/links — { ref }, Capy's LinkIssueRequest.
 * DELETE /api/issues/:code/links — { target }, Capy's UnlinkIssueRequest.
 *
 * These are external references (a pull request, a provider link, a URL), not the
 * task-to-task graph: that stays in the task's metadata and is written by
 * app/actions/issue-operations.ts updateIssueRelation.
 */

export async function GET(request: Request, { params }: { params: Promise<{ code: string }> }) {
  try {
    const context = await collaborationContext(request, (await params).code)
    if (context instanceof Response) return context
    return json(await listIssueLinks(context.issueId))
  } catch (error) { return failure(error) }
}

export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
  try {
    const context = await collaborationContext(request, (await params).code)
    if (context instanceof Response) return context
    let body: unknown
    try { body = await request.json() } catch { return json({ error: 'validationGeneric' }, 400) }
    return json(await addIssueLink(context.issueId, body as never), 201)
  } catch (error) { return failure(error) }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ code: string }> }) {
  try {
    const context = await collaborationContext(request, (await params).code)
    if (context instanceof Response) return context
    let body: unknown
    try { body = await request.json() } catch { return json({ error: 'validationGeneric' }, 400) }
    return json(await removeIssueLink(context.issueId, body as never))
  } catch (error) { return failure(error) }
}
