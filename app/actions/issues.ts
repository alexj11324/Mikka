'use server'

import { headers } from 'next/headers'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { issues, issueVersions } from '@/lib/db/schema'
import type { JSONContent } from '@tiptap/react'

async function getUserId() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new Error('请先登录。')
  return session.user.id
}
const documentSchema = z.custom<JSONContent>(value => {
  if (!value || typeof value !== 'object' || (value as JSONContent).type !== 'doc') return false
  return JSON.stringify(value).length <= 250000
}, '文档格式不正确或超过大小限制。')
const inputSchema = z.object({
  title: z.string().trim().min(1, '请填写任务标题。').max(200),
  content: documentSchema, status: z.enum(['todo','doing','review','done']),
  priority: z.enum(['urgent','high','normal','low']),
})

export async function listIssues() {
  const userId = await getUserId()
  return db.select({ id: issues.id, title: issues.title, status: issues.status, priority: issues.priority, revision: issues.revision, updatedAt: issues.updatedAt }).from(issues).where(eq(issues.userId, userId)).orderBy(desc(issues.updatedAt)).limit(100)
}
export async function getIssue(id: string) {
  z.uuid().parse(id)
  const userId = await getUserId()
  const [issue] = await db.select().from(issues).where(and(eq(issues.id, id), eq(issues.userId, userId))).limit(1)
  if (!issue) throw new Error('任务不存在或没有访问权限。')
  return issue
}
export async function saveIssue(input: { id?: string; revision?: number; title: string; content: JSONContent; status: string; priority: string }) {
  const userId = await getUserId()
  const parsed = inputSchema.safeParse(input)
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? '请检查任务内容。' }
  const id = input.id ? z.uuid().parse(input.id) : crypto.randomUUID()
  if (input.id && (!Number.isInteger(input.revision) || (input.revision ?? 0) < 1)) return { error: '任务版本不正确，请重新打开。' }
  try {
    return await db.transaction(async tx => {
      let issue
      if (input.id) {
        ;[issue] = await tx.update(issues).set({ ...parsed.data, revision: input.revision! + 1, updatedAt: new Date() }).where(and(eq(issues.id, id), eq(issues.userId, userId), eq(issues.revision, input.revision!))).returning()
      } else {
        ;[issue] = await tx.insert(issues).values({ ...parsed.data, id, userId, revision: 1 }).returning()
      }
      if (!issue) return { error: '此任务已被更新或无访问权限。草稿已保留，请重新打开最新版本后再编辑。' }
      await tx.insert(issueVersions).values({ id: crypto.randomUUID(), issueId: id, userId, revision: issue.revision, title: issue.title, content: issue.content, status: issue.status, priority: issue.priority })
      return { issue }
    })
  } catch (error) {
    console.error('保存任务失败', error instanceof Error ? error.message : 'database error')
    return { error: '保存未成功，请保留当前页面后重试。' }
  }
}
export async function listIssueVersions(id: string) {
  z.uuid().parse(id)
  const userId = await getUserId()
  return db.select().from(issueVersions).where(and(eq(issueVersions.issueId, id), eq(issueVersions.userId, userId))).orderBy(desc(issueVersions.revision)).limit(50)
}
