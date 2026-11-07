import { and, asc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { withRequestLog, noteLogUser } from '@/lib/request-log'
import { actAs } from '@/lib/acting-user'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { getIssue } from '@/app/actions/issues'
import { json, mobileUser, unauthorized } from '@/lib/mobile-api'
import { displayTaskTitle } from '@/lib/short-title'
import { db } from '@/lib/db'
import { agentRuns, agents, bots, devices, issues } from '@/lib/db/schema'
import { taskBlock } from '@/lib/task-blocked'
import { runBotId } from '@/lib/run-bot-name'
import { runsOutsideToken } from '@/lib/tokens/scope'
import { machineKind } from '@/lib/mobile-threads'
import { issueContentToMarkdown } from '@/lib/linear-sync/markdown'
import { taskActivity, taskGroup } from '@/lib/mobile-task-group'
import { threadGroup } from '@/lib/thread-groups'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

/**
 * `GET /api/mobile/tasks/:id`: one task as its detail page shows it (decisions/2026-11-07-2045-tasks-only-threads-inside.md):
 * its properties (state, priority, the dispatching Bot, Agent and model, where it runs), its description, and 活动:
 * each of the person's threads on it as an attempt, a replaced thread, and its creation, newest first. Each attempt
 * opens as `GET /api/mobile/threads/:runId`, which holds its raw error code.
 */
async function handleGET(request: Request, { params }: Params) {
  const user = await mobileUser(request)
  noteLogUser(user?.id)
  if (!user) return unauthorized()
  const id = z.uuid().safeParse((await params).id)
  if (!id.success) return json({ error: 'issueNotFound' }, 404)
  const workspaceId = (user as typeof user & { [tokenWorkspace]?: string })[tokenWorkspace]
  const read = workspaceId ? await actAs(user, () => getIssue(id.data)) : await getIssue(id.data)
  if (read.error) return json({ error: 'issueNotFound' }, 404)
  const issue = read.issue
  const rows = await db.select({
    id: agentRuns.id, status: agentRuns.status, outcome: agentRuns.outcome, harness: agents.harness, botId: runBotId,
    model: agentRuns.agentDefinition, replacedBy: agentRuns.threadReplacedBy, createdAt: agentRuns.createdAt,
    deviceName: devices.name, platform: devices.platform, deviceKind: devices.kind,
  }).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId)).leftJoin(devices, eq(devices.id, agentRuns.deviceId))
    .where(and(eq(agentRuns.userId, user.id), eq(agentRuns.issueId, issue.id))).orderBy(asc(agentRuns.createdAt), asc(agentRuns.id)).limit(200)
  const outside = await runsOutsideToken(user, rows.map(row => row.id))
  const runs = rows.filter(row => !outside.has(row.id))
  const newest = runs.at(-1)
  const [bot] = newest?.botId ? await db.select({ id: bots.id, name: bots.name, color: bots.color, shape: bots.shape }).from(bots)
    .where(and(inArray(bots.id, [newest.botId]), eq(bots.ownerId, user.id))).limit(1) : []
  const modelOf = (definition: unknown) => definition && typeof definition === 'object' && typeof (definition as { model?: unknown }).model === 'string' ? (definition as { model: string }).model : null
  // 受阻 as the list judges it (boardBlocks): the newest thread, the person's flag, and any open blocker.
  const blockerIds = issue.metadata.blockedByIds ?? []
  const openBlockers = new Set((blockerIds.length ? await db.select({ id: issues.id, status: issues.status }).from(issues).where(inArray(issues.id, [...blockerIds])) : [])
    .filter(row => !['done', 'canceled', 'duplicate'].includes(row.status)).map(row => row.id))
  const blocked = Boolean(taskBlock(issue, newest ? { runId: newest.id, status: newest.status, outcome: newest.outcome } : undefined, blocker => openBlockers.has(blocker)))
  return json({
    task: {
      id: issue.id, identifier: issue.identifier, title: displayTaskTitle(issue), status: issue.status, priority: issue.priority,
      owner: null, updatedAt: issue.updatedAt, createdAt: issue.createdAt,
      group: taskGroup(issue, newest, blocked),
      bot: bot ?? null,
      agent: newest ? { harness: newest.harness, model: modelOf(newest.model) } : null,
      place: newest?.deviceName ? { kind: machineKind({ name: newest.deviceName, platform: newest.platform, kind: newest.deviceKind }), name: newest.deviceName } : null,
      schedule: null,
      description: issueContentToMarkdown(issue.content).trim() || null,
    },
    activity: taskActivity(runs.map(run => ({
      runId: run.id, harness: run.harness, createdAt: run.createdAt, replacedBy: run.replacedBy,
      group: threadGroup({ id: run.id, status: run.status, issueId: issue.id, createdAt: run.createdAt.toISOString(), outcome: run.outcome }, issue),
      failed: run.status === 'failed' || run.outcome === 'failed',
    })), issue.createdAt),
  })
}

export const GET = withRequestLog('/api/mobile/tasks/[id]', handleGET)
