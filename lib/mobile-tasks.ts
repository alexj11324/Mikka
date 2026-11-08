import 'server-only'
import { withTaskDevicePresence } from './task-state-presence'
import { taskStateOf } from './task-state'
import { runAwaitingApproval, runDeviceOffline, runOfflineDevice } from './task-state-query'
import { runFailureBrief, readCompactRunFailure } from './run-failure-projection'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { agents, agentRuns, bots, devices, issues, issueVersions, users, runPublications } from '@/lib/db/schema'
import { issueForUser } from '@/lib/issue-access'
import { issueTeamAccess } from '@/lib/issue-team-access'
import { taskIdentifiers } from '@/lib/task-identifier-server'
import { readIssueMetadata } from '@/lib/issue-metadata'
import { displayTaskTitle } from '@/lib/short-title'
import { issueContentToMarkdown } from '@/lib/linear-sync/markdown'
import { runBotId } from '@/lib/run-bot-name'
import { taskSchedule, taskScheduleLabels, taskScheduleView } from '@/lib/task-block-runs'
import { enrichActivityActors } from '@/lib/activity-actor-server'
import { mobileTaskActivity } from '@/lib/mobile-task-view'
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
    taskIdentifiers([{ id, ownerId: issue.userId, scope: issue.scope, number: metadata.number }]),
    db.select({ runId: agentRuns.id, status: agentRuns.status, outcome: agentRuns.outcome, pauseReason: agentRuns.pauseReason, stopReason: agentRuns.stopReason, failureDetails: runFailureBrief,
      awaitingApproval: runAwaitingApproval, deviceOffline: runDeviceOffline, offlineDevice: runOfflineDevice, pullRequest: runPublications.pullRequest,
      createdAt: agentRuns.createdAt, threadReplacedBy: agentRuns.threadReplacedBy,
      harness: sql<string>`coalesce(${agentRuns.agentDefinition}->>'harness', ${agents.harness})`,
      model: sql<string | null>`${agentRuns.agentDefinition}->>'model'`,
      bot: { id: bots.id, name: bots.name, color: bots.color, shape: bots.shape },
      device: { name: devices.name, kind: devices.kind, deviceType: devices.deviceType },
      location: sql<string | null>`${agentRuns.agentDefinition}->'modelDispatch'->>'location'`,
    }).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId))
      .leftJoin(runPublications, and(eq(runPublications.runId, agentRuns.id), eq(runPublications.userId, user.id)))
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
    visibleBlockers ? db.select({ id: issues.id, status: issues.status, userId: issues.userId, scope: issues.scope, content: issues.content }).from(issues)
      .where(and(inArray(issues.id, blockerIds), visibleBlockers.predicate)) : [],
  ])
  const [creation] = await enrichActivityActors(versions, issue.userId)
  const task = { ...issue, metadata }
  const attempts = (await withTaskDevicePresence(runs)).map(run => ({ ...run, failureDetails: readCompactRunFailure(run.failureDetails) }))
  const newest = attempts[0]
  const openBlockers = new Set(blockers.filter(blocker => !['done', 'canceled', 'duplicate'].includes(blocker.status)).map(blocker => blocker.id))
  const block = taskBlock(task, newest, blockerId => openBlockers.has(blockerId))
  const blocker = block?.blockerId && blockers.find(row => row.id === block.blockerId)
  if (block && blocker) {
    const names = await taskIdentifiers([{ ...blocker, ownerId: blocker.userId, number: readIssueMetadata(blocker.content).number }])
    block.blockerIdentifier = names.get(blocker.id) ?? null
  }
  const schedule = taskScheduleView(decoration?.schedule ?? null, labels)
  const place = newest?.device
    ? { kind: newest.device.kind === 'cloud' ? 'cloud' as const : newest.device.deviceType, name: newest.device.name }
    : newest?.location === 'cloud' ? { kind: 'cloud' as const, name: 'Cloud' } : null
  return {
    task: {
      id, identifier: identifiers.get(id) ?? null, title: displayTaskTitle({ ...issue, shortTitle: issue.shortTitleFrom === issue.title ? issue.shortTitle : null }), description: issueContentToMarkdown(issue.content).trim() || null,
      status: issue.status, priority: issue.priority, ...taskStateOf(task, newest, { block, schedule }), bot: newest?.bot ?? null,
      agent: newest ? { harness: newest.harness, model: newest.model } : null, place, schedule,
    },
    activity: mobileTaskActivity(task, attempts, { by: creation?.actor ? creation.actor.name : decoration?.owner ?? null, createdAt: issue.createdAt }),
    live: { workspaceId: workspace.id },
  }
}
