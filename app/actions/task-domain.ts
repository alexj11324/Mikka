'use server'
import { requireIssueAccessWithoutBody, requireUser } from '@/lib/issue-access'
import { ActionFailureError } from '@/lib/action-error'
import { effectiveRequestWorkspace } from '@/lib/request-workspace'
import { taskPresentationsInput, type TaskPresentationsInput } from '@/lib/task-presentation-input'
import { readTaskPresentation, readTaskPresentations } from '@/lib/task-presentation-read'

/** Bounded list adapter, refreshed by the existing live channel rather than a
 * new polling loop. An explicit input cannot replace the current tenant. */
export async function getTaskPresentations(input: TaskPresentationsInput) {
  const parsed = taskPresentationsInput.parse(input)
  const user = await requireUser()
  if (await effectiveRequestWorkspace(user) !== parsed.workspaceId) throw new ActionFailureError('workspaceAccessDenied')
  return readTaskPresentations(user, parsed)
}

/** Existing detail contract and its canonical Factory authorization stay intact. */
export async function getTaskPresentation(issueId: string) {
  const { issue, user } = await requireIssueAccessWithoutBody(issueId)
  if (!issue.workspaceId) throw new ActionFailureError('workspaceAccessDenied')
  return readTaskPresentation(user, issue.workspaceId, issue.id)
}
