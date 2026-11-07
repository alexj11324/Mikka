import { and, eq, inArray } from 'drizzle-orm'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { actAs } from '@/lib/acting-user'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { listIssues, listWorkspaceIssues } from '@/app/actions/issues'
import { json, mobileUser, unauthorized } from '@/lib/mobile-api'
import { displayTaskTitle } from '@/lib/short-title'
import { boardBlocks } from '@/components/blocks/kanban-board-1/components/data'
import { newestTaskRuns } from '@/lib/task-block-runs'
import { taskGroup } from '@/lib/mobile-task-group'
import { db } from '@/lib/db'
import { bots } from '@/lib/db/schema'

export const dynamic = 'force-dynamic'

/**
 * `GET /api/mobile/tasks`: the 任务 list: the person's tasks in this workspace, newest change first, each with its
 * 受阻 (lib/task-blocked.ts), its group from its current thread (待处理 · 进行中 · 待办 · 已完成, 2026-11-07) and the
 * Bot that dispatched it. No board on mobile. The newest-thread read is the one 受阻 already makes.
 */
async function handleGET(request: Request) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  const workspaceId = (user as typeof user & { [tokenWorkspace]?: string })[tokenWorkspace]
  const issues = workspaceId ? await actAs(user, () => listWorkspaceIssues(workspaceId)) : await listIssues()
  const open = issues.filter(issue => !['done', 'canceled', 'duplicate'].includes(issue.status))
  const runs = await newestTaskRuns(user.id, open.map(issue => issue.id))
  const blocks = boardBlocks(issues, runs)
  const runOf = new Map(runs.map(run => [run.issueId, run]))
  const botIds = [...new Set(runs.flatMap(run => run.botId ? [run.botId] : []))]
  const botRows = botIds.length ? await db.select({ id: bots.id, name: bots.name, color: bots.color, shape: bots.shape }).from(bots)
    .where(and(inArray(bots.id, botIds), eq(bots.ownerId, user.id))) : []
  const botOf = new Map(botRows.map(bot => [bot.id, bot]))
  return json({
    tasks: issues.map(issue => {
      const block = blocks.get(issue.id)
      const run = runOf.get(issue.id)
      return {
        // The short title the small model wrote, while the task keeps the title it was written from (lib/short-title.ts).
        id: issue.id, identifier: issue.identifier, title: displayTaskTitle(issue), status: issue.status, priority: issue.priority,
        owner: issue.ownerName, updatedAt: issue.updatedAt, createdAt: issue.createdAt,
        blocked: block ? { reason: block.reason, blocker: block.blockerIdentifier ?? null } : null,
        group: taskGroup(issue, run ? { id: run.runId, status: run.status, outcome: run.outcome, createdAt: run.createdAt } : undefined, Boolean(block)),
        bot: run?.botId ? botOf.get(run.botId) ?? null : null,
        // A scheduled task is not linked to a task yet (user_schedules has no issue): no schedule line until it is.
        schedule: null,
      }
    }),
  })
}

export const GET = withRequestLog('/api/mobile/tasks', handleGET)
