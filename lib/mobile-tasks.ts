import 'server-only'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { agents, agentRuns, bots, devices, issues, issueVersions, users } from '@/lib/db/schema'
import { issueAccessForUser, issueForUser } from '@/lib/issue-access'
import { withIssueWorkspace } from '@/lib/issue-scope-authorization'
import { tokenWorkspace } from '@/lib/tokens/principal'
import { enterprisePrincipal } from '@/lib/enterprise/principal'
import { taskIdentifiers } from '@/lib/task-identifier-server'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { displayTaskTitle } from '@/lib/short-title'
import { issueContentToMarkdown } from '@/lib/linear-sync/markdown'
import { runBotId } from '@/lib/run-bot-name'
import { taskSchedule, taskScheduleLabels, taskScheduleView } from '@/lib/task-block-runs'
import { enrichActivityActors } from '@/lib/activity-actor-server'
import { mobileTaskActivity, mobileTaskGroup } from '@/lib/mobile-task-view'
import { issueVisibility, type IssueReader } from '@/lib/issue-visibility'
import { taskBlock } from '@/lib/task-blocked'

/** Locate the persisted tenant through the full reader, then hold fresh
 * membership and re-read every projection. Cookie/default choices are not pins. */
export async function mobileTask(user: Exclude<IssueReader, string>, id: string, explicitWorkspaceId?: string) {
  const candidate = await issueForUser(user, id, false, db, { withoutBody: true })
  if (!candidate || candidate.ownershipState !== 'bound' || !candidate.workspaceId
    || (explicitWorkspaceId !== undefined && candidate.workspaceId !== explicitWorkspaceId)) return null
  const workspaceId = candidate.workspaceId
  return withIssueWorkspace(user, workspaceId, { issueId: id, action: 'canReadContent' }, () => readMobileTask({
    ...user, [tokenWorkspace]: workspaceId, [enterprisePrincipal]: user[enterprisePrincipal],
  }, workspaceId, id))
}

async function readMobileTask(user: Exclude<IssueReader, string>, workspaceId: string, id: string) {
  const access = await issueAccessForUser(user, id)
  if (!access) return null
  const { issue, teamId } = access
  if (issue.ownershipState !== 'bound' || issue.workspaceId !== workspaceId) return null
  const metadata = readIssueMetadata(issue.content)
  const blockerIds = metadata.blockedByIds ?? []
  const visibleBlockers = blockerIds.length ? await issueVisibility(user, false, workspaceId, db, { onlyIssueIds: blockerIds }) : null
  const [identifiers, runs, [decoration], versions, labels, blockers] = await Promise.all([
    taskIdentifiers([{ id, ownerId: issue.userId, scope: issue.scope, number: metadata.number }], db, teamId === null ? new Map() : undefined),
    db.select({ runId: agentRuns.id, status: agentRuns.status, outcome: agentRuns.outcome,
      createdAt: agentRuns.createdAt, threadReplacedBy: agentRuns.threadReplacedBy,
      harness: sql<string>`coalesce(${agentRuns.agentDefinition}->>'harness', ${agents.harness})`,
      model: sql<string | null>`${agentRuns.agentDefinition}->>'model'`,
      bot: { id: bots.id, name: bots.name, color: bots.color, shape: bots.shape },
      device: { name: devices.name, kind: devices.kind, deviceType: devices.deviceType },
      location: sql<string | null>`${agentRuns.agentDefinition}->'modelDispatch'->>'location'`,
    }).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId))
      .leftJoin(bots, and(eq(bots.id, runBotId), eq(bots.ownerId, user.id), eq(bots.workspaceId, workspaceId)))
      .leftJoin(devices, and(eq(devices.id, agentRuns.deviceId), eq(devices.ownerId, user.id)))
      .where(and(eq(agentRuns.issueId, id), eq(agentRuns.userId, user.id), eq(agentRuns.workspaceId, workspaceId)))
      .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id)),
    db.select({ schedule: taskSchedule(issues.id, user.id, workspaceId), owner: users.name }).from(issues)
      .leftJoin(users, eq(users.id, issues.userId))
      .where(and(eq(issues.id, id), eq(issues.workspaceId, workspaceId), eq(issues.ownershipState, 'bound'))),
    db.select({ actorType: issueVersions.actorType, actorId: issueVersions.actorId }).from(issueVersions)
      .where(and(eq(issueVersions.issueId, id), eq(issueVersions.userId, issue.userId)))
      .orderBy(asc(issueVersions.revision)).limit(1),
    taskScheduleLabels(),
    visibleBlockers ? db.select({ id: issues.id, status: issues.status }).from(issues)
      .where(and(inArray(issues.id, blockerIds), visibleBlockers.predicate)) : [],
  ])
  const [creation] = await enrichActivityActors(versions, issue.userId)
  const task = { ...issue, metadata }
  const newest = runs[0]
  const openBlockers = new Set(blockers.filter(blocker => !['done', 'canceled', 'duplicate'].includes(blocker.status)).map(blocker => blocker.id))
  const blocked = Boolean(taskBlock(task, newest, blockerId => openBlockers.has(blockerId)))
  const place = newest?.device
    ? { kind: newest.device.kind === 'cloud' ? 'cloud' as const : newest.device.deviceType, name: newest.device.name }
    : newest?.location === 'cloud' ? { kind: 'cloud' as const, name: 'Cloud' } : null
  return {
    task: {
      id, identifier: identifiers.get(id) ?? null, title: displayTaskTitle({ ...issue, shortTitle: issue.shortTitleFrom === issue.title ? issue.shortTitle : null }), description: issueContentToMarkdown(issue.content).trim() || null,
      status: issue.status, priority: issue.priority, group: mobileTaskGroup(task, newest, blocked), bot: newest?.bot ?? null,
      agent: newest ? { harness: newest.harness, model: newest.model } : null, place, schedule: taskScheduleView(decoration?.schedule ?? null, labels),
    },
    activity: mobileTaskActivity(task, runs, { by: creation?.actor ? creation.actor.name : decoration?.owner ?? null, createdAt: issue.createdAt }),
    live: { workspaceId },
  }
}
