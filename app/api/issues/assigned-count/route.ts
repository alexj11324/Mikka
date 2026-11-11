import { auth } from '@/lib/api-auth'
import { failure, json } from '@/lib/issue-collaboration-route'
import { readIssueCounts } from '@/lib/issue-collaboration'

/**
 * GET /api/issues/assigned-count — how many open tasks are assigned to the
 * caller (Capy's assignedCount, `?captain` omitted: Mikka has no captain scope).
 */
export async function GET(request: Request) {
  try {
    const session = await auth.api.getSession({ headers: request.headers })
    if (!session?.user) return json({ error: 'authRequired' }, 401)
    const counts = await readIssueCounts(session.user.id)
    return json({ count: counts.assigned })
  } catch (error) { return failure(error) }
}
