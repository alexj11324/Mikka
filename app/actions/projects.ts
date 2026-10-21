'use server'

import { headers } from 'next/headers'
import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { projectDb, projects, projectEvents } from '@/lib/db/projects'
import { requireIssueAccess } from '@/lib/issue-access'
import { projectInput, projectPatch, hasDependencyCycle, type ProjectChanges } from '@/lib/project-input'
import { accessibleProjects } from '@/lib/project-access'
import { teamIssues, teamProjects } from '@/lib/db/team-schema'
import { inArray } from 'drizzle-orm'
import { lockTeamRelations } from '@/lib/team-access'

async function userId() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new Error('请先登录。')
  return session.user.id
}
export async function listProjects() {
  const owner = await userId()
  return (await accessibleProjects(owner)).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
}
async function persistProject(owner: string, input: unknown, partial: boolean) {
  try {
    return await projectDb.transaction(async tx => {
      await lockTeamRelations(tx)
      const owned = await accessibleProjects(owner, tx)
      const patch = partial ? projectPatch.safeParse(input) : null
      if (patch && !patch.success) return { error: patch.error.issues[0]?.message ?? '属性格式不正确。' }
      const current = patch?.success ? owned.find(item => item.id === patch.data.id) : undefined
      if (patch?.success && !current) return { error: '项目不存在或无访问权限。' }
      const parsed = projectInput.safeParse(patch?.success ? { ...current, ...patch.data.changes, id: patch.data.id, revision: patch.data.revision } : input)
      if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? '请检查项目属性。' }
      const { id, revision, ...values } = parsed.data
      if (id && (!revision || !owned.some(item => item.id === id && item.revision === revision))) return { error: '项目已更新，请刷新后重试，避免覆盖他人的修改。' }
      if (values.properties.dependencyIds.some(value => !owned.some(item => item.id === value))) return { error: '依赖项目不存在或无访问权限。' }
      const projectOwner = id ? owned.find(item => item.id === id)!.userId : owner
      const links = id ? await tx.select().from(teamProjects).where(eq(teamProjects.projectId, id)) : []
      if (links.length && values.properties.dependencyIds.length) {
        const dependencies = await tx.select().from(teamProjects).where(inArray(teamProjects.projectId, values.properties.dependencyIds))
        if (values.properties.dependencyIds.some(dependencyId => !dependencies.some(link => link.projectId === dependencyId && link.workspaceId === links[0].workspaceId))) return { error: '公开项目只能依赖同一工作区内的公开项目。' }
      }
      const nextId = id ?? crypto.randomUUID()
      if (hasDependencyCycle(nextId, values.properties.dependencyIds, owned)) return { error: '项目不能依赖自身，也不能形成循环依赖。' }
      const [project] = id ? await tx.update(projects).set({ ...values, revision: revision! + 1, updatedAt: new Date() }).where(and(eq(projects.id, id), eq(projects.userId, projectOwner), eq(projects.revision, revision!))).returning() : await tx.insert(projects).values({ ...values, id: nextId, userId: owner, issueIds: [], revision: 1 }).returning()
      if (!project) return { error: '项目已更新或无访问权限，请刷新后重试。' }
      const names: Record<string, string> = { status: '状态', priority: '优先级', lead: '负责人', startDate: '开始日期', targetDate: '目标日期', properties: '项目属性', name: '名称', summary: '摘要', description: '描述', team: '团队' }
      const message = patch?.success ? `更新了${Object.keys(patch.data.changes).map(key => names[key]).join('、')}` : id ? '更新了项目属性与概览' : '创建了项目'
      await tx.insert(projectEvents).values({ id: crypto.randomUUID(), userId: projectOwner, projectId: project.id, message })
      return { project }
    })
  } catch { return { error: '项目保存失败，输入已保留，请稍后重试。' } }
}
export async function saveProject(input: z.input<typeof projectInput>) {
  return persistProject(await userId(), input, false)
}
export async function updateProjectProperties(input: { id: string; revision: number; changes: ProjectChanges }) {
  return persistProject(await userId(), input, true)
}
export async function listProjectEvents(id: string) {
  const owner = await userId()
  z.uuid().parse(id)
  const project = (await accessibleProjects(owner)).find(item => item.id === id)
  if (!project) throw new Error('项目不存在或没有访问权限。')
  return projectDb.select().from(projectEvents).where(and(eq(projectEvents.projectId, id), eq(projectEvents.userId, project.userId))).orderBy(desc(projectEvents.createdAt)).limit(100)
}
export async function setProjectIssues(input: { id: string; revision: number; issueIds: string[] }) {
  const owner = await userId()
  const parsed = z.object({ id: z.uuid(), revision: z.number().int().positive(), issueIds: z.array(z.uuid()).max(100) }).safeParse(input)
  if (!parsed.success) return { error: '任务关联信息不正确。' }
  const ids = [...new Set(parsed.data.issueIds)]
  try {
    for (const id of ids) await requireIssueAccess(id)
    return await projectDb.transaction(async tx => {
      await lockTeamRelations(tx)
      const owned = await accessibleProjects(owner, tx)
      const current = owned.find(project => project.id === input.id)
      if (!current) return { error: '项目不存在或无访问权限。' }
      const links = await tx.select().from(teamProjects).where(eq(teamProjects.projectId, current.id))
      const taskLinks = ids.length ? await tx.select().from(teamIssues).where(inArray(teamIssues.issueId, ids)) : []
      if (links.length && ids.some(id => !taskLinks.some(link => link.issueId === id && links.some(team => team.teamId === link.teamId)))) return { error: '公开项目只能关联其团队内的任务，请先设置任务团队归属。' }
      if (ids.length) {
        const conflicts = await tx.select({ id: projects.id }).from(projects).where(and(sql`${projects.id} <> ${current.id}`, sql`${projects.issueIds} ?| array[${sql.join(ids.map(id => sql`${id}`), sql`, `)}]`)).limit(1)
        if (conflicts.length) return { error: '一个任务只能属于一个项目，请先从原项目移除。' }
      }
      const [project] = await tx.update(projects).set({ issueIds: ids, revision: input.revision + 1, updatedAt: new Date() }).where(and(eq(projects.id, input.id), eq(projects.userId, current.userId), eq(projects.revision, input.revision))).returning()
      if (!project) return { error: '项目已更新或无访问权限，请刷新后重试。' }
      await tx.insert(projectEvents).values({ id: crypto.randomUUID(), userId: current.userId, projectId: project.id, message: `更新了项目任务，当前共 ${ids.length} 项` })
      return { project }
    })
  } catch { return { error: '任务关联失败，请确认访问权限后重试。' } }
}
