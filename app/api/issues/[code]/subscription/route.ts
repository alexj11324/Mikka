import { collaborationContext, failure, json } from '@/lib/issue-collaboration-route'
import { setIssueSubscription } from '@/lib/issue-collaboration'

/**
 * PUT /api/issues/:code/subscription — { subscribed: boolean }, Capy's
 * SetSubscriptionRequest. Idempotent, so a page that sends the state it already
 * shows and a retried request land on the same answer.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ code: string }> }) {
  try {
    const context = await collaborationContext(request, (await params).code)
    if (context instanceof Response) return context
    let body: unknown
    try { body = await request.json() } catch { return json({ error: 'validationGeneric' }, 400) }
    const subscribed = (body as { subscribed?: unknown } | null)?.subscribed
    if (typeof subscribed !== 'boolean') return json({ error: 'validationGeneric' }, 400)
    return json(await setIssueSubscription(context.issueId, subscribed))
  } catch (error) { return failure(error) }
}
