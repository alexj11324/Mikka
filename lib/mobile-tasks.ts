import 'server-only'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { agents, agentRuns, bots, devices, issues, issueVersions, users } from '@/lib/db/schema'
import { issueForUser } from '@/lib/issue-access'
import { issueTeamAccess } from '@/lib/issue-team-access'
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

/** A fresh workspace context is required; task visibility still uses the existing task ACL. */
export async function mobileTask(user: Exclude<IssueReader, string>, workspace: { id: string; kind: string }, id: string) {
  const issue = await issueForUser(user, id)
  if (!issue) return null
  const access = await issueTeamAccess(id, user.id)
  if (access.linked ? !access.allowed || access.workspaceId !== workspace.id : workspace.kind !== 'personal') return null
  const metadata = readIssueMetadata(issue.content)
  const blockerIds = metadata.blockedByIds ?? []
  const visibleBlockers = blockerIds.length ? await issueVisibility(user, false, workspace.id, db, { onlyIssueIds: blockerIds }) : null
  const [identifiers, runs, [decoration], versions, labels, blockers] = await Promise.all([
    taskIdentifiers([{ id, ownerId: issue.userId, scope: issue.scope, number: metadata.number }], db, access.linked === false ? new Map() : undefined),
    db.select({ runId: agentRuns.id, status: agentRuns.status, outcome: agentRuns.outcome,
      createdAt: agentRuns.createdAt, threadReplacedBy: agentRuns.threadReplacedBy,
      harness: sql<string>`coalesce(${agentRuns.agentDefinition}->>'harness', ${agents.harness})`,
      model: sql<string | null>`${agentRuns.agentDefinition}->>'model'`,
      bot: { id: bots.id, name: bots.name, color: bots.color, shape: bots.shape },
      device: { name: devices.name, kind: devices.kind, deviceType: devices.deviceType },
      location: sql<string | null>`${agentRuns.agentDefinition}->'modelDispatch'->>'location'`,
    }).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId))
      .leftJoin(bots, and(eq(bots.id, runBotId), eq(bots.ownerId, user.id), eq(bots.workspaceId, workspace.id)))
      .leftJoin(devices, and(eq(devices.id, agentRuns.deviceId), eq(devices.ownerId, user.id)))
      .where(and(eq(agentRuns.issueId, id), eq(agentRuns.userId, user.id)))
      .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id)),
    db.select({ schedule: taskSchedule(issues.id, user.id, workspace.id), owner: users.name }).from(issues)
      .leftJoin(users, eq(users.id, issues.userId)).where(eq(issues.id, id)),
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
    live: { workspaceId: workspace.id },
  }
}
