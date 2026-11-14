'use server'

import { and, eq, inArray, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError, runAction } from '@/lib/action-error'
import { db } from '@/lib/db'
import { persistIssueMetadata } from '@/lib/issue-metadata-store'
import { issueMembersChanged } from '@/lib/live/issue-detail'
import { agents, bots, issues, issueMembers, users } from '@/lib/db/schema'
import { factoryAgentProfiles } from '@/lib/db/agent-profile-schema'
import { builtinAgentProfileDefinition, BUILTIN_AGENT_PROFILE_ID } from '@/lib/factory/agent-profile-definition'
import { workspaceMembers } from '@/lib/db/workspace-schema'
import { workspaceDb } from '@/lib/workspace-db'
import { withTaskWorkspace } from '@/lib/task-workspace'
import { projectViewsForTasks } from '@/lib/project-access'
import { issuePropertyChoices } from '@/lib/issue-property-choices'
import { requireIssueAccess } from '@/lib/issue-access'
import { listWorkspaceProjects } from '@/app/actions/projects'
import { issueView } from '@/lib/task-identifier-server'
import { assigneeSchema, delegateSchema, blockFlagSchema, labelSchema, pullRequestSchema, readIssueMetadata } from '@/lib/issue-metadata'
import { scheduleIssueEffect } from '@/lib/issue-effects'
import { activityActor } from '@/lib/activity-actor'
import { requireCurrentIssueWorkspace, requireLockedIssueScope, withIssueWorkspace } from '@/lib/issue-scope-authorization'

const patchSchema = z.object({
  // R-60 keeps the UI human-only; the verified legacy MCP contract remains supported.
  assignee: assigneeSchema.pick({ kind: true, id: true }).nullable().optional(),
  delegate: delegateSchema.pick({ kind: true, id: true }).nullable().optional(),
  project: z.string().trim().min(1).max(100).nullable().optional(),
  labels: z.array(labelSchema).max(12).optional(),
  pullRequests: z.array(pullRequestSchema).max(10).optional(),
  dueDate: z.iso.date().nullable().optional(),
  estimate: z.number().int().min(0).max(100).nullable().optional(),
  /** 受阻 by hand: moved into the column, or out of it (lib/task-blocked.ts). */
  block: blockFlagSchema.nullable().optional(),
}).strict()
export type IssueMetadataPatch = z.infer<typeof patchSchema>

export async function getIssuePropertyOptions(id: string) {
  const { issue, user } = await requireIssueAccess(id)
  return db.transaction(async tx => {
  const [locked] = await tx.select().from(issues).where(eq(issues.id, id)).for('share')
  requireLockedIssueScope(locked, user.id, issue.scopeVersion, issue.workspaceId)
  await requireCurrentIssueWorkspace(user, issue.workspaceId, issue.id)
  const activeMembers = await workspaceDb.select({ id: workspaceMembers.userId }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, issue.workspaceId!), eq(workspaceMembers.status, 'active')))
  const members = activeMembers.length ? await tx.select({ id: users.id, name: users.name, image: users.image }).from(users)
    .where(inArray(users.id, activeMembers.map(member => member.id))) : []
  const choices = await issuePropertyChoices(user.id)
  const projectRecords = await listWorkspaceProjects(locked.workspaceId!)
  return {
    members,
    projects: [...new Set(projectRecords.map(item => item.name))].sort(),
    projectRecords: projectRecords.map(item => ({ id: item.id, name: item.name })),

    labels: choices.labels,
    isOwner: user.id === issue.userId,
  }
  })
}

export async function updateIssueMetadata(input: { id: string; revision: number; patch: IssueMetadataPatch; inviteEmail?: string }) {
  return runAction(async () => {
    const parsed = z.object({ id: z.uuid(), revision: z.number().int().positive(), patch: patchSchema, inviteEmail: z.email().max(254).optional() }).safeParse(input)
    if (!parsed.success) return { error: 'issueMetadataInvalid' }
    const { issue, user } = await requireIssueAccess(parsed.data.id)
    if (parsed.data.patch.assignee?.kind === 'agent' && activityActor(user.id).actorType !== 'agent') return { error: 'issueMetadataInvalid' }
    // A legacy Agent assignment and a modern delegate in the same request are
    // ambiguous. Refuse it instead of clearing a person's responsibility.
    if (parsed.data.patch.assignee?.kind === 'agent' && parsed.data.patch.delegate !== undefined) return { error: 'issueMetadataInvalid' }
    if (parsed.data.inviteEmail && user.id !== issue.userId) return { error: 'memberOwnerOnly' }
    try {
      const invitee = parsed.data.inviteEmail ? (await db.select({ id: users.id }).from(users).where(eq(users.email, parsed.data.inviteEmail.toLowerCase())).limit(1))[0] : undefined
      if (parsed.data.inviteEmail && !invitee) return { error: 'memberNotRegistered' }
      const assigneeId = invitee?.id ?? (parsed.data.patch.assignee?.kind === 'member' ? parsed.data.patch.assignee.id : undefined)
      // Acquire both authoritative memberships before locking APP. Suspension
      // cannot race an assignment; the existing WS -> APP lock order is kept.
      const withAssignee = <T>(work: () => Promise<T>) => assigneeId
        ? withTaskWorkspace(assigneeId, issue.workspaceId!, work)
        : work()
      const result = await withIssueWorkspace(user, issue.workspaceId, { issueId: issue.id, action: 'canSteer' }, () => withAssignee(() => db.transaction(async tx => {
        const [latest] = await tx.select().from(issues).where(and(eq(issues.id, issue.id), eq(issues.userId, issue.userId))).for('update')
        requireLockedIssueScope(latest, user.id, issue.scopeVersion, issue.workspaceId)
        if (!latest || latest.revision !== parsed.data.revision) return { error: 'issueOutdated' }
        const metadata = readIssueMetadata(latest.content)
        const patch = parsed.data.patch
        if (patch.project !== undefined) {
          const project = (await projectViewsForTasks([latest])).get(latest.id)
          // Legacy name writes may echo the current relation but cannot create
          // a second Project truth. Relation changes use moveIssueToProject.
          if (patch.project !== (project?.project ?? null)) return { error: 'issueMetadataInvalid' }
        }
        let assignee = metadata.assignee
        let delegate = metadata.delegate
        if (parsed.data.inviteEmail) {
          if (user.id !== issue.userId) return { error: 'memberOwnerOnly' }
          const [member] = await tx.select({ id: users.id, name: users.name, image: users.image }).from(users).where(eq(users.email, parsed.data.inviteEmail.toLowerCase())).for('share')
          if (!member) return { error: 'memberNotRegistered' }
          assignee = { ...member, kind: 'member' }
        } else if (patch.assignee === null) assignee = null
        else if (patch.assignee?.kind === 'member') {
            const [member] = await tx.select({ id: users.id, name: users.name, image: users.image }).from(users).where(eq(users.id, patch.assignee.id)).for('share')
            if (!member) return { error: 'memberNotFound' }
            assignee = { ...member, kind: 'member' }
        }
        const requestedDelegate = patch.assignee?.kind === 'agent' ? patch.assignee : patch.delegate
        if (requestedDelegate === null) delegate = null
        else if (requestedDelegate) {
          if (requestedDelegate.kind === 'profile' && requestedDelegate.id === BUILTIN_AGENT_PROFILE_ID) {
            delegate = { id: BUILTIN_AGENT_PROFILE_ID, kind: 'profile', name: builtinAgentProfileDefinition().name, image: null }
          } else if (!z.uuid().safeParse(requestedDelegate.id).success) return { error: 'issueMetadataInvalid' }
          else if (requestedDelegate.kind === 'agent') {
            const [agent] = await tx.select({ id: agents.id, name: agents.name }).from(agents)
              .where(and(eq(agents.id, requestedDelegate.id), eq(agents.userId, issue.userId))).for('share')
            if (!agent) return { error: 'agentNotFound' }
            delegate = { ...agent, kind: 'agent', image: null }
          } else if (requestedDelegate.kind === 'bot') {
            const [bot] = await tx.select({ id: bots.id, name: bots.name }).from(bots)
              .where(and(eq(bots.id, requestedDelegate.id), eq(bots.workspaceId, issue.workspaceId!), eq(bots.ownerId, user.id), isNull(bots.archivedAt))).for('share')
            if (!bot) return { error: 'agentNotFound' }
            delegate = { ...bot, kind: 'bot', image: null }
          } else {
            const [profile] = await tx.select({ id: factoryAgentProfiles.id, definition: factoryAgentProfiles.definition }).from(factoryAgentProfiles)
              .where(and(eq(factoryAgentProfiles.id, requestedDelegate.id), eq(factoryAgentProfiles.workspaceId, issue.workspaceId!), eq(factoryAgentProfiles.ownerId, user.id), isNull(factoryAgentProfiles.archivedAt))).for('share')
            if (!profile || !profile.definition.enabled) return { error: 'agentNotFound' }
            delegate = { id: profile.id, name: profile.definition.name, kind: 'profile', image: null }
          }
        }
        const next = { ...metadata, ...patch, assignee, delegate, ...(requestedDelegate !== undefined ? { delegateSelection: 'manual' as const } : {}) }
        next.labels = [...new Map(next.labels.map(label => [label.name.toLowerCase(), label])).values()]
        next.pullRequests = [...new Map(next.pullRequests.map(pr => [pr.url.replace(/\/$/, ''), { ...pr, url: pr.url.replace(/\/$/, '') }])).values()]
        const saved = await persistIssueMetadata(tx, latest, next, activityActor(user.id))
        if (!saved) return { error: 'issueOutdated' }
        // Invitation bookkeeping follows every validation and the revision
        // fence. An invalid delegate must not leave a partial invitation.
        if (parsed.data.inviteEmail && assignee?.kind === 'member' && assignee.id !== issue.userId) {
          const added = await tx.insert(issueMembers).values({ issueId: issue.id, userId: issue.userId, memberId: assignee.id }).onConflictDoNothing().returning({ memberId: issueMembers.memberId })
          if (added.length) await issueMembersChanged(tx, issue.id)
        }
        return { issue: await issueView(saved, tx) }
      })))
      if ('issue' in result && result.issue?.linearSyncPolicy === 'explicit' && !result.issue.linearSyncBlocked && result.issue.linearTargetVerified) scheduleIssueEffect({ kind: 'sync', issueId: result.issue.id })
      return result
    } catch (error) {
      if (error instanceof ActionFailureError && error.code === 'workspaceAccessDenied') return { error: 'memberNotJoined' }
      if (error instanceof ActionFailureError) throw error
      return { error: 'issueMetadataSaveFailed' }
    }
  })
}
