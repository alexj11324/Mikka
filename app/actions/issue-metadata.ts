'use server'

import { and, eq, or } from 'drizzle-orm'
import { z } from 'zod'
import { ActionFailureError, runAction } from '@/lib/action-error'
import { db } from '@/lib/db'
import { agents, issues, issueMembers, issueVersions, users } from '@/lib/db/schema'
import { requireIssueAccess } from '@/lib/issue-access'
import { listProjects } from '@/app/actions/projects'
import { assigneeSchema, issueWithMetadata, labelSchema, pullRequestSchema, readIssueMetadata, withIssueMetadata } from '@/lib/issue-metadata'
import { dispatchLinearIssueSync } from '@/lib/linear-sync/dispatch'
import { activityActor } from '@/lib/activity-actor'

const patchSchema = z.object({
  assignee: assigneeSchema.pick({ kind: true, id: true }).nullable().optional(),
  project: z.string().trim().min(1).max(100).nullable().optional(),
  labels: z.array(labelSchema).max(12).optional(),
  pullRequests: z.array(pullRequestSchema).max(10).optional(),
  dueDate: z.iso.date().nullable().optional(),
  estimate: z.number().int().min(0).max(100).nullable().optional(),
}).strict()
export type IssueMetadataPatch = z.infer<typeof patchSchema>

export async function getIssuePropertyOptions(id: string) {
  const { issue, user } = await requireIssueAccess(id)
  const [owner] = await db.select({ id: users.id, name: users.name, image: users.image }).from(users).where(eq(users.id, issue.userId))
  const members = await db.select({ id: users.id, name: users.name, image: users.image }).from(issueMembers).innerJoin(users, eq(users.id, issueMembers.memberId)).where(and(eq(issueMembers.issueId, id), eq(issueMembers.userId, issue.userId)))
  const availableAgents = await db.select({ id: agents.id, name: agents.name, harness: agents.harness }).from(agents).where(eq(agents.userId, issue.userId))
  const ownedIssues = await db.select({ content: issues.content }).from(issues).where(user.id === issue.userId ? eq(issues.userId, issue.userId) : or(eq(issues.userId, user.id), eq(issues.userId, issue.userId)))
  const metadata = ownedIssues.map(row => readIssueMetadata(row.content))
  const projectRecords = await listProjects()
  return {
    members: owner ? [owner, ...members.filter(member => member.id !== owner.id)] : members,
    agents: availableAgents,
    projects: [...new Set(projectRecords.map(item => item.name))].sort(),
    projectRecords: projectRecords.map(item => ({ id: item.id, name: item.name })),

    labels: [...new Map(metadata.flatMap(item => item.labels).map(label => [label.name, label])).values()],
    isOwner: user.id === issue.userId,
  }
}

export async function updateIssueMetadata(input: { id: string; revision: number; patch: IssueMetadataPatch; inviteEmail?: string }) {
  return runAction(async () => {
    const parsed = z.object({ id: z.uuid(), revision: z.number().int().positive(), patch: patchSchema, inviteEmail: z.email().max(254).optional() }).safeParse(input)
    if (!parsed.success) return { error: 'issueMetadataInvalid' }
    const { issue, user } = await requireIssueAccess(parsed.data.id)
    try {
      const result = await db.transaction(async tx => {
        const [latest] = await tx.select().from(issues).where(and(eq(issues.id, issue.id), eq(issues.userId, issue.userId))).for('update')
        if (!latest || latest.revision !== parsed.data.revision) return { error: 'issueOutdated' }
        if (user.id !== issue.userId) {
          const [membership] = await tx.select({ id: issueMembers.memberId }).from(issueMembers).where(and(eq(issueMembers.issueId, issue.id), eq(issueMembers.userId, issue.userId), eq(issueMembers.memberId, user.id)))
          if (!membership) return { error: 'issueAccessLost' }
        }
        const metadata = readIssueMetadata(latest.content)
        const patch = parsed.data.patch
        let assignee = metadata.assignee
        if (parsed.data.inviteEmail) {
          if (user.id !== issue.userId) return { error: 'memberOwnerOnly' }
          const [member] = await tx.select({ id: users.id, name: users.name, image: users.image }).from(users).where(eq(users.email, parsed.data.inviteEmail.toLowerCase()))
          if (!member) return { error: 'memberNotRegistered' }
          if (member.id !== issue.userId) await tx.insert(issueMembers).values({ issueId: issue.id, userId: issue.userId, memberId: member.id }).onConflictDoNothing()
          assignee = { ...member, kind: 'member' }
        } else if (patch.assignee === null) assignee = null
        else if (patch.assignee) {
          if (patch.assignee.kind === 'agent') {
            const [agent] = await tx.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.id, z.uuid().parse(patch.assignee.id)), eq(agents.userId, issue.userId)))
            if (!agent) return { error: 'agentNotFound' }
            assignee = { ...agent, kind: 'agent', image: null }
          } else {
            const [member] = await tx.select({ id: users.id, name: users.name, image: users.image }).from(users).where(eq(users.id, patch.assignee.id))
            if (!member) return { error: 'memberNotFound' }
            if (member.id !== issue.userId) {
              const [membership] = await tx.select({ id: issueMembers.memberId }).from(issueMembers).where(and(eq(issueMembers.issueId, issue.id), eq(issueMembers.userId, issue.userId), eq(issueMembers.memberId, member.id)))
              if (!membership) return { error: 'memberNotJoined' }
            }
            assignee = { ...member, kind: 'member' }
          }
        }
        const next = { ...metadata, ...patch, assignee }
        next.labels = [...new Map(next.labels.map(label => [label.name.toLowerCase(), label])).values()]
        next.pullRequests = [...new Map(next.pullRequests.map(pr => [pr.url.replace(/\/$/, ''), { ...pr, url: pr.url.replace(/\/$/, '') }])).values()]
        const [saved] = await tx.update(issues).set({ content: withIssueMetadata(latest.content, next), revision: latest.revision + 1, updatedAt: new Date() }).where(and(eq(issues.id, issue.id), eq(issues.userId, issue.userId), eq(issues.revision, latest.revision))).returning()
        if (!saved) return { error: 'issueOutdated' }
        await tx.insert(issueVersions).values({ id: crypto.randomUUID(), issueId: saved.id, userId: saved.userId, revision: saved.revision, title: saved.title, content: saved.content, status: saved.status, priority: saved.priority, ...activityActor(user.id) })
        return { issue: issueWithMetadata(saved) }
      })
      if ('issue' in result && result.issue) dispatchLinearIssueSync(result.issue.id)
      return result
    } catch (error) {
      if (error instanceof ActionFailureError) throw error
      return { error: 'issueMetadataSaveFailed' }
    }
  })
}
