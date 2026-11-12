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
  const batch = await readTaskPresentations(user, parsed)
  if (parsed.includeReview && Object.keys(batch.items).length) {
    const { taskReviewSummaries } = await import('@/lib/coding-workspace/task-review/summaries')
    const reviews = await taskReviewSummaries(user, Object.keys(batch.items), parsed.workspaceId)
    for (const [id, summary] of reviews) {
      if (!summary.pr && !summary.files) continue
      batch.items[id]!.review = {
        pr: summary.pr && { number: summary.pr.number, state: summary.pr.state },
        files: summary.files, additions: summary.additions, deletions: summary.deletions,
        checks: summary.checks && { failed: summary.checks.failed }, running: summary.running,
      }
    }
  }
  return batch
}

/** Existing detail contract and its canonical Factory authorization stay intact. */
export async function getTaskPresentation(issueId: string) {
  const { issue, user } = await requireIssueAccessWithoutBody(issueId)
  if (!issue.workspaceId) throw new ActionFailureError('workspaceAccessDenied')
  return readTaskPresentation(user, issue.workspaceId, issue.id)
}
