import { defaultAgentCopy as agentCopy } from '@/lib/agent-copy'
import 'server-only'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { agentSessions, agentTurns } from '@/lib/db/schema'
import { sessionPreview } from '@/lib/agent-history'

export class AgentStoreError extends Error {
  constructor(message: string, public status: number) { super(message) }
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
