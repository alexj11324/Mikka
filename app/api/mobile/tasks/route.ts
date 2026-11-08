import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { actAs } from '@/lib/acting-user'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { pollIssues, listWorkspaceIssues } from '@/app/actions/issues'
import { json, mobileUser, unauthorized } from '@/lib/mobile-api'
import { displayTaskTitle } from '@/lib/short-title'
import { boardBlocks } from '@/components/blocks/kanban-board-1/components/data'
import { newestTaskRuns, taskScheduleLabels } from '@/lib/task-block-runs'
import { taskStateOf } from '@/lib/task-state'

export const dynamic = 'force-dynamic'

/** `GET /api/mobile/tasks`: the 任务 list: the person's tasks in this workspace, newest change first, each with its 受阻 (lib/task-blocked.ts). No board on mobile. */
async function handleGET(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  const tokenWorkspaceId = (user as typeof user & { [tokenWorkspace]?: string })[tokenWorkspace]
  // Keep the selected workspace already resolved by the existing list read; no extra context query.
  const { issues, workspaceId } = tokenWorkspaceId
    ? { issues: await actAs(user, () => listWorkspaceIssues(tokenWorkspaceId)), workspaceId: tokenWorkspaceId }
    : await pollIssues().then(snapshot => ({ issues: snapshot.items!, workspaceId: snapshot.live.selectedWorkspaceId }))
  const snapshots = await newestTaskRuns(user.id, issues.map(issue => issue.id), workspaceId, await taskScheduleLabels())
  const runs = snapshots.flatMap(row => row.runId && row.status ? [{ ...row, runId: row.runId, status: row.status }] : [])
  const byIssue = new Map(snapshots.map(row => [row.issueId, row]))
  const runByIssue = new Map(runs.map(row => [row.issueId, row]))
  const blocks = boardBlocks(issues, runs)
  return json({
    tasks: issues.map(issue => {
      const block = blocks.get(issue.id)
      return {
        // The short title the small model wrote, while the task keeps the title it was written from (lib/short-title.ts).
        id: issue.id, identifier: issue.identifier, title: displayTaskTitle(issue), status: issue.status, priority: issue.priority,
        owner: issue.ownerName, updatedAt: issue.updatedAt,
        createdAt: issue.createdAt, ...taskStateOf(issue, runByIssue.get(issue.id), { block, schedule: byIssue.get(issue.id)?.schedule }),
        bot: byIssue.get(issue.id)?.bot ?? null, schedule: byIssue.get(issue.id)?.schedule ?? null,
        blocked: block ? { reason: block.reason, blocker: block.blockerIdentifier ?? null } : null,
      }
    }),
  })
}

export const GET = withRequestLog('/api/mobile/tasks', handleGET)
