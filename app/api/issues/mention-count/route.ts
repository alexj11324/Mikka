import { auth } from '@/lib/api-auth'
import { failure, json } from '@/lib/issue-collaboration-route'
import { readIssueCounts } from '@/lib/issue-collaboration'

/**
 * GET /api/issues/mention-count — how many comments reached a task the caller
 * can read, from someone else, since the caller last looked at it (Capy's
 * mentionCount).
 *
 * Mikka's document comments cannot be parsed for an @-mention, so a mention is a
 * comment that arrived after the caller's seen marker — the same shape Capy
 * derives from `IssueViewer.mentions`, and the reason POST :code/seen exists.
 */
export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session?.user) return json({ error: 'authRequired' }, 401)
    const counts = await readIssueCounts(session.user.id)
    return json({ count: counts.mentions })
  } catch (error) { return failure(error) }
}
