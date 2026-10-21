'use server'

import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { agents, issues, issueMembers, issueVersions, users } from '@/lib/db/schema'
import { requireIssueAccess } from '@/lib/issue-access'
import { listProjects } from '@/app/actions/projects'
import { assigneeSchema, issueWithMetadata, labelSchema, pullRequestSchema, readIssueMetadata, withIssueMetadata } from '@/lib/issue-metadata'

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
  const ownedIssues = await db.select({ content: issues.content }).from(issues).where(eq(issues.userId, user.id))
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
  const parsed = z.object({ id: z.uuid(), revision: z.number().int().positive(), patch: patchSchema, inviteEmail: z.email().max(254).optional() }).safeParse(input)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? '属性格式不正确。' }
  const { issue, user } = await requireIssueAccess(parsed.data.id)
  try {
    return await db.transaction(async tx => {
      const [latest] = await tx.select().from(issues).where(and(eq(issues.id, issue.id), eq(issues.userId, issue.userId))).for('update')
      if (!latest || latest.revision !== parsed.data.revision) return { error: '任务已被更新，请刷新后重试。' }
      if (user.id !== issue.userId) {
        const [membership] = await tx.select({ id: issueMembers.memberId }).from(issueMembers).where(and(eq(issueMembers.issueId, issue.id), eq(issueMembers.userId, issue.userId), eq(issueMembers.memberId, user.id)))
        if (!membership) return { error: '你已失去此任务的访问权限。' }
      }
      const metadata = readIssueMetadata(latest.content)
      const patch = parsed.data.patch
      let assignee = metadata.assignee
      if (parsed.data.inviteEmail) {
        if (user.id !== issue.userId) return { error: '只有所有者可以邀请并分配成员。' }
        const [member] = await tx.select({ id: users.id, name: users.name, image: users.image }).from(users).where(eq(users.email, parsed.data.inviteEmail.toLowerCase()))
        if (!member) return { error: '该邮箱尚未注册，请对方先注册后再邀请。' }
        if (member.id !== issue.userId) await tx.insert(issueMembers).values({ issueId: issue.id, userId: issue.userId, memberId: member.id }).onConflictDoNothing()
        assignee = { ...member, kind: 'member' }
      } else if (patch.assignee === null) assignee = null
      else if (patch.assignee) {
        if (patch.assignee.kind === 'agent') {
          const [agent] = await tx.select({ id: agents.id, name: agents.name }).from(agents).where(and(eq(agents.id, z.uuid().parse(patch.assignee.id)), eq(agents.userId, issue.userId)))
          if (!agent) return { error: '此 Agent 不存在或无权分配。' }
          assignee = { ...agent, kind: 'agent', image: null }
        } else {
          const [member] = await tx.select({ id: users.id, name: users.name, image: users.image }).from(users).where(eq(users.id, patch.assignee.id))
          if (!member) return { error: '成员不存在。' }
          if (member.id !== issue.userId) {
            const [membership] = await tx.select({ id: issueMembers.memberId }).from(issueMembers).where(and(eq(issueMembers.issueId, issue.id), eq(issueMembers.userId, issue.userId), eq(issueMembers.memberId, member.id)))
            if (!membership) return { error: '请先邀请该成员加入此任务。' }
          }
          assignee = { ...member, kind: 'member' }
        }
      }
      const next = { ...metadata, ...patch, assignee }
      next.labels = [...new Map(next.labels.map(label => [label.name.toLowerCase(), label])).values()]
      next.pullRequests = [...new Map(next.pullRequests.map(pr => [pr.url.replace(/\/$/, ''), { ...pr, url: pr.url.replace(/\/$/, '') }])).values()]
      const [saved] = await tx.update(issues).set({ content: withIssueMetadata(latest.content, next), revision: latest.revision + 1, updatedAt: new Date() }).where(and(eq(issues.id, issue.id), eq(issues.userId, issue.userId), eq(issues.revision, latest.revision))).returning()
      if (!saved) return { error: '任务已被更新，请重试。' }
      await tx.insert(issueVersions).values({ id: crypto.randomUUID(), issueId: saved.id, userId: saved.userId, revision: saved.revision, title: saved.title, content: saved.content, status: saved.status, priority: saved.priority })
      return { issue: issueWithMetadata(saved) }
    })
  } catch {
    return { error: '属性保存失败，请稍后重试。' }
  }
}
