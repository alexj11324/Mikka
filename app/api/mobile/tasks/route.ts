import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { actAs } from '@/lib/acting-user'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { listIssues, listWorkspaceIssues } from '@/app/actions/issues'
import { json, mobileUser, unauthorized } from '@/lib/mobile-api'
import { displayTaskTitle } from '@/lib/short-title'
import { boardBlocks } from '@/components/blocks/kanban-board-1/components/data'
import { newestTaskRuns } from '@/lib/task-block-runs'

export const dynamic = 'force-dynamic'

/** `GET /api/mobile/tasks`: the 任务 list: the person's tasks in this workspace, newest change first, each with its 受阻 (lib/task-blocked.ts). No board on mobile. */
async function handleGET(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  const workspaceId = (user as typeof user & { [tokenWorkspace]?: string })[tokenWorkspace]
  const issues = workspaceId ? await actAs(user, () => listWorkspaceIssues(workspaceId)) : await listIssues()
  const open = issues.filter(issue => !['done', 'canceled', 'duplicate'].includes(issue.status))
  const blocks = boardBlocks(issues, await newestTaskRuns(user.id, open.map(issue => issue.id)))
  return json({
    tasks: issues.map(issue => {
      const block = blocks.get(issue.id)
      return {
        // The short title the small model wrote, while the task keeps the title it was written from (lib/short-title.ts).
        id: issue.id, identifier: issue.identifier, title: displayTaskTitle(issue), status: issue.status, priority: issue.priority,
        owner: issue.ownerName, updatedAt: issue.updatedAt,
        blocked: block ? { reason: block.reason, blocker: block.blockerIdentifier ?? null } : null,
      }
    }),
  })
}

export const GET = withRequestLog('/api/mobile/tasks', handleGET)
