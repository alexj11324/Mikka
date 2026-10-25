import { defaultAgentCopy as agentCopy } from '@/lib/agent-copy'
import 'server-only'
import { and, asc, desc, eq, gt, ne, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { agentSessions, agentTurns } from '@/lib/db/schema'
import { sessionPreview, type AgentCheckpoint } from '@/lib/agent-history'

export class AgentStoreError extends Error {
  constructor(message: string, public status: number) { super(message) }
}

export async function beginAgentTurn(userId: string, sessionId: string, turnId: string, prompt: string, retry = false) {
  const attemptId = crypto.randomUUID()
  return db.transaction(async tx => {
    // The scoped upsert also locks the session until commit, serializing concurrent turns.
    const [session] = await tx.insert(agentSessions).values({ id: sessionId, userId, title: prompt.slice(0, 200) })
      .onConflictDoUpdate({ target: agentSessions.id, set: { updatedAt: new Date() }, setWhere: eq(agentSessions.userId, userId) })
      .returning({ id: agentSessions.id })
    if (!session) throw new AgentStoreError(agentCopy.conversationNotFound, 404)
    const [active] = await tx.select({ id: agentTurns.id }).from(agentTurns).where(and(
      eq(agentTurns.sessionId, sessionId), eq(agentTurns.userId, userId), eq(agentTurns.status, 'pending'),
      gt(agentTurns.updatedAt, new Date(Date.now() - 330000)),
    )).limit(1)
    if (active) throw new AgentStoreError(agentCopy.aResponseIsStillGeneratingPleaseTry, 409)
    const [existing] = await tx.select().from(agentTurns).where(and(eq(agentTurns.id, turnId), eq(agentTurns.userId, userId))).limit(1)
    if (existing && (existing.sessionId !== sessionId || existing.prompt !== prompt || (existing.status === 'complete' && !retry))) {
      throw new AgentStoreError(agentCopy.thisMessageWasAlreadySubmittedPleaseAsk, 409)
    }
    if (existing) {
      const [latest] = await tx.select({ id: agentTurns.id }).from(agentTurns)
        .where(and(eq(agentTurns.sessionId, sessionId), eq(agentTurns.userId, userId)))
        .orderBy(desc(agentTurns.createdAt), desc(agentTurns.id)).limit(1)
      if (latest?.id !== turnId) throw new AgentStoreError(agentCopy.onlyTheLastResponseCanBeRetried, 409)
      await tx.update(agentTurns).set({ status: 'pending', completion: '', error: null, attemptId, updatedAt: new Date() })
        .where(and(eq(agentTurns.id, turnId), eq(agentTurns.userId, userId), eq(agentTurns.sessionId, sessionId)))
    } else {
      const inserted = await tx.insert(agentTurns).values({ id: turnId, sessionId, userId, prompt, attemptId }).onConflictDoNothing().returning({ id: agentTurns.id })
      if (!inserted.length) throw new AgentStoreError(agentCopy.invalidMessageIDPleaseAskANew, 409)
    }
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
  const selected = db.select({ id: agentSessions.id }).from(agentSessions)
    .where(and(eq(agentSessions.userId, userId), requestedId ? eq(agentSessions.id, requestedId) : undefined))
    .orderBy(desc(agentSessions.updatedAt), desc(agentSessions.id)).limit(1).as('selected')
  const [sessions, rows] = await Promise.all([
    db.select({
      id: agentSessions.id, title: agentSessions.title, updatedAt: agentSessions.updatedAt,
      // The last turn feeds the second line of the conversation list (MIK-35).
      lastPrompt: sql<string | null>`(select t."prompt" from "agent_turns" t where t."sessionId" = "agent_sessions"."id" and t."userId" = ${userId} order by t."createdAt" desc limit 1)`,
      lastCompletion: sql<string | null>`(select left(t."completion", 2000) from "agent_turns" t where t."sessionId" = "agent_sessions"."id" and t."userId" = ${userId} order by t."createdAt" desc limit 1)`,
    }).from(agentSessions).where(eq(agentSessions.userId, userId))
      .orderBy(desc(agentSessions.updatedAt), desc(agentSessions.id)).limit(100),
    fresh ? Promise.resolve([]) : db.select({
      sessionId: selected.id,
      turn: { id: agentTurns.id, prompt: agentTurns.prompt, completion: agentTurns.completion, status: agentTurns.status, error: agentTurns.error },
    }).from(selected).leftJoin(agentTurns, and(eq(agentTurns.sessionId, selected.id), eq(agentTurns.userId, userId)))
      .orderBy(asc(agentTurns.createdAt), asc(agentTurns.id)),
  ])
  const sessionId = rows[0]?.sessionId ?? null
  if (requestedId && !fresh && !sessionId) throw new AgentStoreError(agentCopy.conversationNotFound, 404)
  return { sessions: sessions.map(({ lastPrompt, lastCompletion, ...session }) => ({ ...session, updatedAt: session.updatedAt.toISOString(), preview: sessionPreview(lastCompletion, lastPrompt) })), sessionId, turns: rows.flatMap(row => row.turn ? [row.turn] : []) }
}
