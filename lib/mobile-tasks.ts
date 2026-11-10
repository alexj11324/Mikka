import 'server-only'
import { withTaskDevicePresence } from './task-state-presence'
import { taskStateOf } from './task-state'
import { taskStateRunColumns } from './task-state-query'
import { readCompactRunFailure } from './run-failure-projection'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { agents, agentRuns, bots, devices, issues, issueVersions, users, runPublications } from '@/lib/db/schema'
import { issueForUser } from '@/lib/issue-access'
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
import { mobileTaskActivity } from '@/lib/mobile-task-view'
import { issueVisibility, type IssueReader } from '@/lib/issue-visibility'
import { taskBlock } from '@/lib/task-blocked'
import { taskReviewSummaries } from '@/lib/coding-workspace/task-review/summaries'
import { taskReviewSourceHint } from '@/lib/coding-workspace/task-review/summary-selection'

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
  const issue = await issueForUser(user, id)
  if (!issue || issue.ownershipState !== 'bound' || issue.workspaceId !== workspaceId) return null
  const metadata = readIssueMetadata(issue.content)
  const blockerIds = metadata.blockedByIds ?? []
  const visibleBlockers = blockerIds.length ? await issueVisibility(user, false, workspaceId, db, { onlyIssueIds: blockerIds }) : null
  const [identifiers, runs, [decoration], versions, labels, blockers] = await Promise.all([
    taskIdentifiers([{ id, ownerId: issue.userId, scope: issue.scope, number: metadata.number, issuedIdentifier: issue.issuedIdentifier }]),
    db.select({ ...taskStateRunColumns, pullRequest: runPublications.pullRequest,
      createdAt: agentRuns.createdAt,
      harness: sql<string>`coalesce(${agentRuns.agentDefinition}->>'harness', ${agents.harness})`,
      model: sql<string | null>`${agentRuns.agentDefinition}->>'model'`,
      bot: { id: bots.id, name: bots.name, color: bots.color, shape: bots.shape },
      device: { name: devices.name, kind: devices.kind, deviceType: devices.deviceType },
      location: sql<string | null>`${agentRuns.agentDefinition}->'modelDispatch'->>'location'`,
    }).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId))
      .leftJoin(runPublications, and(eq(runPublications.runId, agentRuns.id), eq(runPublications.userId, user.id)))
      .leftJoin(bots, and(eq(bots.id, runBotId), eq(bots.ownerId, user.id), eq(bots.workspaceId, workspaceId)))
      .leftJoin(devices, and(eq(devices.id, agentRuns.deviceId), eq(devices.ownerId, user.id)))
      .where(and(eq(agentRuns.issueId, id), eq(agentRuns.userId, user.id), eq(agentRuns.workspaceId, workspaceId)))
      .orderBy(desc(agentRuns.createdAt), desc(agentRuns.id)),
    db.select({ schedule: taskSchedule(issues.id, user.id, workspaceId), owner: users.name, codingReview: taskReviewSourceHint }).from(issues)
      .leftJoin(users, eq(users.id, issues.userId))
      .where(and(eq(issues.id, id), eq(issues.workspaceId, workspaceId), eq(issues.ownershipState, 'bound'))),
    db.select({ actorType: issueVersions.actorType, actorId: issueVersions.actorId }).from(issueVersions)
      .where(and(eq(issueVersions.issueId, id), eq(issueVersions.userId, issue.userId)))
      .orderBy(asc(issueVersions.revision)).limit(1),
    taskScheduleLabels(),
    visibleBlockers ? db.select({ id: issues.id, status: issues.status, userId: issues.userId, scope: issues.scope, content: issues.content, issuedIdentifier: issues.issuedIdentifier }).from(issues)
      .where(and(inArray(issues.id, blockerIds), visibleBlockers.predicate)) : [],
  ])
  const reviews = await taskReviewSummaries(user, decoration?.codingReview ? [id] : [], workspaceId)
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
      review: reviews.get(id) ?? null,
    },
    activity: mobileTaskActivity(task, attempts, { by: creation?.actor ? creation.actor.name : decoration?.owner ?? null, createdAt: issue.createdAt }),
    live: { workspaceId },
  }
}
