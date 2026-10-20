'use server'

import { headers } from 'next/headers'
import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { projectDb, projects, projectEvents } from '@/lib/db/projects'
import { requireIssueAccess } from '@/lib/issue-access'
import { WORKSPACE_NAME } from '@/components/workspace/issue-properties'

async function userId() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new Error('请先登录。')
  return session.user.id
}
const date = z.union([z.literal(''), z.iso.date()])
const projectInput = z.object({
  id: z.uuid().optional(), revision: z.number().int().positive().optional(), name: z.string().trim().min(1, '请填写项目名称。').max(200), summary: z.string().trim().max(500), description: z.string().max(50000), status: z.enum(['backlog', 'planned', 'started', 'paused', 'completed', 'canceled']), priority: z.enum(['urgent', 'high', 'normal', 'low']), lead: z.enum(['', 'me']), team: z.literal(WORKSPACE_NAME), startDate: date, targetDate: date,
}).refine(value => !value.startDate || !value.targetDate || value.startDate <= value.targetDate, '目标日期不能早于开始日期。')
export async function listProjects() {
  const owner = await userId()
  return projectDb.select().from(projects).where(eq(projects.userId, owner)).orderBy(desc(projects.updatedAt))
}
export async function saveProject(input: z.input<typeof projectInput>) {
  const owner = await userId()
  const parsed = projectInput.safeParse(input)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? '请检查项目属性。' }
  const { id, revision, ...values } = parsed.data
  if (id && !revision) return { error: '请重新加载项目后重试。' }
  try {
    return await projectDb.transaction(async tx => {
      const [project] = id ? await tx.update(projects).set({ ...values, revision: revision! + 1, updatedAt: new Date() }).where(and(eq(projects.id, id), eq(projects.userId, owner), eq(projects.revision, revision!))).returning() : await tx.insert(projects).values({ ...values, id: crypto.randomUUID(), userId: owner, issueIds: [], revision: 1 }).returning()
      if (!project) return { error: '项目已更新或无访问权限，请刷新后重试。' }
      await tx.insert(projectEvents).values({ id: crypto.randomUUID(), userId: owner, projectId: project.id, message: id ? '更新了项目属性与概览' : '创建了项目' })
      return { project }
    })
  } catch { return { error: '项目保存失败，输入已保留，请稍后重试。' } }
}
export async function listProjectEvents(id: string) {
  const owner = await userId()
  z.uuid().parse(id)
  return projectDb.select().from(projectEvents).where(and(eq(projectEvents.projectId, id), eq(projectEvents.userId, owner))).orderBy(desc(projectEvents.createdAt)).limit(100)
}
export async function setProjectIssues(input: { id: string; revision: number; issueIds: string[] }) {
  const owner = await userId()
  const parsed = z.object({ id: z.uuid(), revision: z.number().int().positive(), issueIds: z.array(z.uuid()).max(100) }).safeParse(input)
  if (!parsed.success) return { error: '任务关联信息不正确。' }
  const ids = [...new Set(parsed.data.issueIds)]
  try {
    for (const id of ids) await requireIssueAccess(id)
    return await projectDb.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${owner}, 0))`)
      const owned = await tx.select().from(projects).where(eq(projects.userId, owner))
      if (owned.some(project => project.id !== input.id && project.issueIds.some(id => ids.includes(id)))) return { error: '一个任务只能属于一个项目，请先从原项目移除。' }
      const [project] = await tx.update(projects).set({ issueIds: ids, revision: input.revision + 1, updatedAt: new Date() }).where(and(eq(projects.id, input.id), eq(projects.userId, owner), eq(projects.revision, input.revision))).returning()
      if (!project) return { error: '项目已更新或无访问权限，请刷新后重试。' }
      await tx.insert(projectEvents).values({ id: crypto.randomUUID(), userId: owner, projectId: project.id, message: `更新了项目任务，当前共 ${ids.length} 项` })
      return { project }
    })
  } catch { return { error: '任务关联失败，请确认访问权限后重试。' } }
}
