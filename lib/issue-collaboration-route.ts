import 'server-only'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { auth, apiWorkspaceAllowed, type ApiSession } from '@/lib/api-auth'
import { actAs } from '@/lib/acting-user'
import { ActionFailureError } from '@/lib/action-error'
import { WorkspaceError, loadWorkspaceContext } from '@/lib/workspace-access'
import { issueAccessForUser } from '@/lib/issue-access'
import { resolveTaskIdentifierAlias } from '@/lib/task-identity-store'

/**
 * The shared frame of the task collaboration routes (app/api/issues/[code]/…):
 * one place that authenticates, resolves `:code` to a task, and turns the
 * library's errors into the statuses these routes answer with.
 *
 * `:code` is a task's identifier (`ALE-12`) or its uuid, whichever the caller
 * has. Both reach the same access check, so a code names a task and never widens
 * who may read it.
 */

/** A task page's data is never shared or stored. */
const privateHeaders = { 'Cache-Control': 'private, no-store' } as const

export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: privateHeaders })

/**
 * The error status for a failure raised inside a collaboration route. A task the
 * caller cannot see answers 404, never 403, so the response never confirms that
 * a task exists to someone it is not shared with.
 */
export function failure(error: unknown) {
  if (error instanceof ActionFailureError) {
    if (error.code === 'authRequired') return json({ error: error.code }, 401)
    // A malformed body or a reply target that is not this task's comment is the
    // caller's mistake, and saying so reveals nothing about another task.
    if (error.code === 'issueCommentInvalid' || error.code === 'issueLinkInvalid' || error.code === 'issueCommentReplyTargetNotFound') {
      return json({ error: error.code }, 400)
    }
    return json({ error: 'issueNotFound' }, 404)
  }
  if (error instanceof WorkspaceError) return json({ error: error.code }, 403)
  if (error instanceof Error && error.name === 'ZodError') return json({ error: 'validationGeneric' }, 400)
  console.error('Issue collaboration failed', error instanceof Error ? error.name : 'UnknownError')
  return json({ error: 'issueCollaborationFailed' }, 500)
}

export type CollaborationContext = { session: ApiSession; issueId: string }

/** Authenticates the request and resolves its task, or answers the failure it hit. */
export async function collaborationContext(request: Request, code: string): Promise<CollaborationContext | Response> {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return json({ error: 'authRequired' }, 401)
  const issueId = await resolveIssueId(code, session)
  // One answer for a task that does not exist and one the caller cannot read.
  if (!issueId) return json({ error: 'issueNotFound' }, 404)
  return { session, issueId }
}

/**
 * A task's identifier or uuid, resolved to its id only when this caller may read
 * it. `issueAccessForUser` is the same check the task page uses, so an API caller
 * sees exactly the tasks the page would show them.
 */
async function resolveIssueId(code: string, session: ApiSession): Promise<string | null> {
  let candidate = code
  if (!z.uuid().safeParse(code).success) {
    // An identifier is a lookup hint inside one workspace, never an access grant:
    // the ACL read below still decides, and an ambiguous code resolves to nothing.
    const context = await loadWorkspaceContext(undefined, session.user)
    const resolved = await resolveTaskIdentifierAlias({ workspaceId: context.workspace.id, identifier: code })
    if (resolved.kind !== 'found') return null
    candidate = resolved.issueId
  }
  const access = await actAs(session.user, () => issueAccessForUser(session.user, candidate))
  if (!access) return null
  // A personal token reads only its own workspace, as every other route enforces.
  if (access.issue.workspaceId && !apiWorkspaceAllowed(session, access.issue.workspaceId)) return null
  return access.issue.id
}
