import 'server-only'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from './db'
import { bots, issues, users } from './db/schema'
import { workspaceMembers } from './db/workspace-schema'
import { ActionFailureError } from './action-error'
import { readIssueMetadata, type IssueMetadata } from './issue-metadata'
import { persistIssueMetadata } from './issue-metadata-store'
import { issueAssignedEvent } from './coordinator-events'
import { recordCoordinatorEvent } from './coordinator-event-store'
import type { ActivityActor } from './activity-actor'
import type { CreateAccess, CreateAssignee, CreateOnlyCommand } from './task-create-command'
import type { WorkspaceTransaction } from './task-workspace'
import { resolveTaskLabelIds, resolveTaskLabelNames } from './task-labels/references'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Membership = Pick<WorkspaceTransaction, 'select'>

/** The create window's properties beyond title, text, status and priority. */
export type CreateProperties = Pick<CreateOnlyCommand, 'assignee' | 'dueDate' | 'labels' | 'labelIds' | 'access'>

export function hasCreateProperties(properties: CreateProperties) {
  return Boolean(properties.assignee || properties.dueDate || properties.labels?.length || properties.labelIds?.length || properties.access?.kind === 'members')
}

/**
 * Apply the create window's properties to a task created in this same APP transaction, through the same writers a
 * later edit uses: one metadata revision (persistIssueMetadata), the task ACL for Only specific people, and the
 * assigned Bot's wake. Every refusal throws, so the whole create rolls back with it.
 */
export async function applyCreateProperties(tx: Transaction, membership: Membership, input: {
  user: { id: string; name: string | null }; workspaceId: string; taskId: string; identifier: string
  properties: CreateProperties; actor: ActivityActor
}) {
  const { user, workspaceId, taskId, properties } = input
  if (!hasCreateProperties(properties)) return
  const [task] = await tx.select().from(issues).where(and(eq(issues.id, taskId), eq(issues.workspaceId, workspaceId))).for('update')
  if (!task) throw new ActionFailureError('issueNotFound')
  const metadata = readIssueMetadata(task.content)
  const assignment = properties.assignee ? await resolveAssignee(tx, membership, user.id, workspaceId, properties.assignee) : null
  const next: IssueMetadata = {
    ...metadata,
    ...(assignment?.assignee ? { assignee: assignment.assignee } : {}),
    ...(assignment?.delegate ? { delegate: assignment.delegate, delegateSelection: 'manual' as const } : {}),
    ...(properties.dueDate ? { dueDate: properties.dueDate } : {}),
    ...(properties.labels?.length ? await resolveTaskLabelNames(tx, workspaceId, properties.labels.map(label => label.name)) : {}),
    ...(properties.labelIds ? await resolveTaskLabelIds(tx, workspaceId, properties.labelIds) : {}),
  }
  const saved = assignment || properties.dueDate || properties.labels?.length || properties.labelIds?.length ? await persistIssueMetadata(tx, task, next, input.actor) : task
  if (!saved) throw new ActionFailureError('issueOutdated')
  if (properties.access?.kind === 'members') await setTaskVisibility(tx, membership, { taskId, workspaceId, ownerId: user.id, access: properties.access })
  if (assignment?.delegate) {
    await recordCoordinatorEvent(tx, issueAssignedEvent({ id: taskId, ownerId: user.id, identifier: input.identifier, title: saved.title, revision: saved.revision },
      assignment.delegate, { name: user.name || input.identifier }))
  }
}

/** A person must be an active member of the task's workspace; a Bot must be one of the creator's own, live Bots in
 * it (the same rule as assigning one later in app/actions/issue-metadata.ts). */
async function resolveAssignee(tx: Transaction, membership: Membership, userId: string, workspaceId: string, assignee: CreateAssignee) {
  if (assignee.kind === 'bot') {
    const [bot] = await tx.select({ id: bots.id, name: bots.name }).from(bots)
      .where(and(eq(bots.id, assignee.id), eq(bots.workspaceId, workspaceId), eq(bots.ownerId, userId), isNull(bots.archivedAt))).for('share')
    if (!bot) throw new ActionFailureError('agentNotFound')
    return { assignee: null, delegate: { ...bot, kind: 'bot' as const, image: null } }
  }
  const [active] = await membership.select({ id: workspaceMembers.userId }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, assignee.id), eq(workspaceMembers.status, 'active')))
  if (!active) throw new ActionFailureError('memberNotJoined')
  const [member] = await tx.select({ id: users.id, name: users.name, image: users.image }).from(users).where(eq(users.id, assignee.id)).for('share')
  if (!member) throw new ActionFailureError('memberNotFound')
  return { assignee: { ...member, kind: 'member' as const }, delegate: null }
}

/**
 * Only specific people: the task stays private to its owner and each listed active member gets the shared content
 * actions as an explicit grant, as the owner's sharing dialog writes them (lib/resource-access/store.ts). Runs on a
 * task whose policy this transaction just registered, so there is no earlier audience to confirm against.
 */
export async function setTaskVisibility(tx: Pick<Transaction, 'execute'>, membership: Membership, input: { taskId: string; workspaceId: string; ownerId: string; access: CreateAccess }) {
  if (input.access.kind !== 'members') return
  const subjects = [...new Set(input.access.memberIds)].filter(id => id !== input.ownerId)
  const active = subjects.length ? await membership.select({ id: workspaceMembers.userId }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.status, 'active'), inArray(workspaceMembers.userId, subjects))) : []
  if (active.length !== subjects.length) throw new ActionFailureError('workspaceAccessDenied')
  await tx.execute(sql`select set_config('mikka.acl_actor',${input.ownerId},true),set_config('mikka.acl_source','owner_access_change',true)`)
  const updated = await tx.execute(sql`update resource_access_policies set visibility='private'
    where kind='task' and id=${input.taskId}::uuid and "workspaceId"=${input.workspaceId}::uuid and "ownerId"=${input.ownerId}`)
  if (!updated.rowCount) throw new ActionFailureError('workspaceAccessDenied')
  for (const subject of subjects) await tx.execute(sql`insert into resource_access_grants("resourceKind","resourceId","subjectKind","subjectId",capabilities,"expiresAt")
    values('task',${input.taskId}::uuid,'account',${subject},${sql.param(['canReadContent', 'canComment', 'canSteer'])}::text[],null)
    on conflict do nothing`)
}
