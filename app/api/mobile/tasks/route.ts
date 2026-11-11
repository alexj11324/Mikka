import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { actAs } from '@/lib/acting-user'
import { ActionFailureError } from '@/lib/action-error'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { WorkspaceError } from '@/lib/workspace-error'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { nextTaskListCursor, taskListPageInput } from '@/lib/task-list-page'
import { pollIssues, listWorkspaceIssues, listWorkspaceTaskPage } from '@/app/actions/issues'
import { json, mobileUser, unauthorized } from '@/lib/mobile-api'
import { displayTaskTitle } from '@/lib/short-title'
import { boardBlocks } from '@/components/blocks/kanban-board-1/components/data'
import { newestTaskRuns, taskScheduleLabels } from '@/lib/task-block-runs'
import { taskStateOf } from '@/lib/task-state'
import { taskReviewSummaries } from '@/lib/coding-workspace/task-review/summaries'

export const dynamic = 'force-dynamic'

/** `GET /api/mobile/tasks`: the 任务 list: the person's tasks in this workspace, newest change first, each with its 受阻 (lib/task-blocked.ts). No board on mobile. */
async function handleGET(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  try {
    return await actAs(user, async () => {
      const tokenWorkspaceId = (user as typeof user & { [tokenWorkspace]?: string })[tokenWorkspace]
      // Keep the selected workspace already resolved by the existing list read; no extra context query.
      const params = new URL(request.url).searchParams
      const continuation = params.has('after') || params.has('updatedAt')
      const page = continuation ? taskListPageInput.safeParse({ workspaceId: params.get('workspaceId'),
        after: { id: params.get('after'), updatedAt: params.get('updatedAt') } }) : null
      if (page && !page.success) return json({ error: 'validationGeneric' }, 400)
      const nextPage = page?.success ? await listWorkspaceTaskPage(page.data) : null
      if (nextPage?.reset) return json({ error: 'issueStale' }, 409)
      const { issues, workspaceId } = nextPage
        ? { issues: nextPage.items, workspaceId: nextPage.workspaceId }
        : tokenWorkspaceId ? { issues: await listWorkspaceIssues(tokenWorkspaceId), workspaceId: tokenWorkspaceId }
          : await pollIssues().then(snapshot => ({ issues: snapshot.items!, workspaceId: snapshot.live.selectedWorkspaceId }))
      // Recheck and hold the exact tenant before decorating or returning the
      // authorized list. A revocation that wins admission cannot return it.
      return withTaskWorkspace(user, workspaceId, async () => {
        const snapshots = await newestTaskRuns(user.id, issues.map(issue => issue.id), workspaceId, await taskScheduleLabels())
        const reviews = await taskReviewSummaries(user, snapshots.filter(row => row.codingReview).map(row => row.issueId), workspaceId)
        const runs = snapshots.flatMap(row => row.runId && row.status ? [{ ...row, runId: row.runId, status: row.status }] : [])
        const byIssue = new Map(snapshots.map(row => [row.issueId, row]))
        const runByIssue = new Map(runs.map(row => [row.issueId, row]))
        const blocks = boardBlocks(issues, runs)
        return json({
          workspaceId, next: nextTaskListCursor(issues),
          tasks: issues.map(issue => {
            const block = blocks.get(issue.id)
            return {
              // The short title the small model wrote, while the task keeps the title it was written from (lib/short-title.ts).
              id: issue.id, identifier: issue.identifier, title: displayTaskTitle(issue), status: issue.status, priority: issue.priority,
              owner: issue.ownerName, updatedAt: issue.updatedAt,
              createdAt: issue.createdAt, ...taskStateOf(issue, runByIssue.get(issue.id), { block, schedule: byIssue.get(issue.id)?.schedule }),
              bot: byIssue.get(issue.id)?.bot ?? null, schedule: byIssue.get(issue.id)?.schedule ?? null,
              blocked: block ? { reason: block.reason, blocker: block.blockerIdentifier ?? null } : null,
              review: reviews.get(issue.id) ?? null,
            }
          }),
        })
      })
    })
  } catch (error) {
    if (error instanceof ActionFailureError && error.code === 'issueStale') return json({ error: 'issueStale' }, 409)
    if (error instanceof WorkspaceError || (error instanceof ActionFailureError && error.code === 'workspaceAccessDenied'))
      return json({ error: 'workspaceAccessDenied' }, 403)
    throw error
  }
}

export const GET = withRequestLog('/api/mobile/tasks', handleGET)
