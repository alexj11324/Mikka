import 'server-only'
import { and, asc, desc, eq, gt, ne } from 'drizzle-orm'
import { db } from '@/lib/db'
import { agentSessions, agentTurns } from '@/lib/db/schema'
import type { AgentCheckpoint } from '@/lib/agent-history'

export class AgentStoreError extends Error {
  constructor(message: string, public status: number) { super(message) }
}

export async function beginAgentTurn(userId: string, sessionId: string, turnId: string, prompt: string, retry = false) {
  const attemptId = crypto.randomUUID()
  return db.transaction(async tx => {
    await tx.insert(agentSessions).values({ id: sessionId, userId, title: prompt.slice(0, 200) }).onConflictDoNothing()
    const [session] = await tx.select({ id: agentSessions.id }).from(agentSessions)
      .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId))).for('update')
    if (!session) throw new AgentStoreError('找不到此会话。', 404)
    const [active] = await tx.select({ id: agentTurns.id }).from(agentTurns).where(and(
      eq(agentTurns.sessionId, sessionId), eq(agentTurns.userId, userId), eq(agentTurns.status, 'pending'),
      gt(agentTurns.updatedAt, new Date(Date.now() - 330000)),
    )).limit(1)
    if (active) throw new AgentStoreError('此会话仍有回复正在生成，请稍后重试。', 409)
    const [existing] = await tx.select().from(agentTurns).where(and(eq(agentTurns.id, turnId), eq(agentTurns.userId, userId))).limit(1)
    if (existing && (existing.sessionId !== sessionId || existing.prompt !== prompt || (existing.status === 'complete' && !retry))) {
      throw new AgentStoreError('此轮消息不能重复提交，请新建一轮提问。', 409)
    }
    if (existing) {
      const [latest] = await tx.select({ id: agentTurns.id }).from(agentTurns)
        .where(and(eq(agentTurns.sessionId, sessionId), eq(agentTurns.userId, userId)))
        .orderBy(desc(agentTurns.createdAt), desc(agentTurns.id)).limit(1)
      if (latest?.id !== turnId) throw new AgentStoreError('只能重试会话中的最后一轮回复。', 409)
      await tx.update(agentTurns).set({ status: 'pending', completion: '', error: null, attemptId, updatedAt: new Date() })
        .where(and(eq(agentTurns.id, turnId), eq(agentTurns.userId, userId), eq(agentTurns.sessionId, sessionId)))
    } else {
      const inserted = await tx.insert(agentTurns).values({ id: turnId, sessionId, userId, prompt, attemptId }).onConflictDoNothing().returning({ id: agentTurns.id })
      if (!inserted.length) throw new AgentStoreError('消息标识无效，请新建一轮提问。', 409)
    }
    await tx.update(agentSessions).set({ updatedAt: new Date() }).where(and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId)))
    const history = await tx.select({ prompt: agentTurns.prompt, completion: agentTurns.completion }).from(agentTurns)
      .where(and(eq(agentTurns.sessionId, sessionId), eq(agentTurns.userId, userId), eq(agentTurns.status, 'complete'), ne(agentTurns.id, turnId)))
      .orderBy(desc(agentTurns.createdAt), desc(agentTurns.id)).limit(12)
    return { attemptId, history: history.reverse() }
  })
}

export async function saveAgentTurn(userId: string, sessionId: string, turnId: string, attemptId: string, checkpoint: AgentCheckpoint) {
  await db.transaction(async tx => {
    const updated = await tx.update(agentTurns).set({ ...checkpoint, updatedAt: new Date() }).where(and(
      eq(agentTurns.id, turnId), eq(agentTurns.userId, userId), eq(agentTurns.sessionId, sessionId),
      eq(agentTurns.attemptId, attemptId), eq(agentTurns.status, 'pending'),
    )).returning({ id: agentTurns.id })
    if (updated.length) await tx.update(agentSessions).set({ updatedAt: new Date() })
      .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId)))
  })
}

export async function getAgentHistory(userId: string, requestedId?: string, fresh = false) {
  const sessions = await db.select({ id: agentSessions.id, title: agentSessions.title, updatedAt: agentSessions.updatedAt })
    .from(agentSessions).where(eq(agentSessions.userId, userId)).orderBy(desc(agentSessions.updatedAt)).limit(100)
  const sessionId = fresh ? null : requestedId ?? sessions[0]?.id ?? null
  if (!sessionId) return { sessions, sessionId: null, turns: [] }
  const [session] = await db.select({ id: agentSessions.id }).from(agentSessions)
    .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, userId))).limit(1)
  if (!session) throw new AgentStoreError('找不到此会话。', 404)
  const turns = await db.select({ id: agentTurns.id, prompt: agentTurns.prompt, completion: agentTurns.completion, status: agentTurns.status, error: agentTurns.error })
    .from(agentTurns).where(and(eq(agentTurns.sessionId, sessionId), eq(agentTurns.userId, userId)))
    .orderBy(asc(agentTurns.createdAt), asc(agentTurns.id))
  return { sessions, sessionId, turns }
}
