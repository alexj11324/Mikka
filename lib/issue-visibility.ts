import 'server-only'
import { db } from '@/lib/db'
import { issueTeamScope } from '@/lib/issue-team-access'
import { issueVisibilityPredicate } from '@/lib/issue-visibility-policy'

/** Resolve workspace membership in its own DB; never cross-join the two DBs.
 * No request/global cache: suspension/removal takes effect on the next read.
 * `_executor` is unused (membership lives in the workspace DB); it stays only
 * so existing callers that pass a transaction keep compiling. */
export async function issueVisibility(userId: string, includeDeleted = false, workspaceId?: string, _executor: Pick<typeof db, 'select'> = db) {
  const allowed = await issueTeamScope(userId)
  const allowedIds = allowed.filter(link => !workspaceId || link.workspaceId === workspaceId).map(link => link.issueId)
  return { predicate: issueVisibilityPredicate(userId, { allowedIds }, includeDeleted), allowedIds }
}
