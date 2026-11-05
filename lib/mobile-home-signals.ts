import 'server-only'
import { pool } from '@/lib/db'
import { chatMark, type WaitingMark } from '@/lib/mobile-chat-marks'

export type HomeSignal = { waiting: WaitingMark | null; unread: number }

/**
 * Per-bot marks for the home list, in the same read as GET /api/mobile/home (no extra request from the app).
 * Question: a thread still waiting on the person. Approval: a pending action from that bot.
 * Takeover: the person holds that bot's computer. Unread: replies after the read position, counted
 * the way the chat does (a run of assistant rows is one reply).
 */
export async function homeChatSignals(userId: string, workspaceId: string): Promise<Map<string, HomeSignal>> {
  const [questions, approvals, takeovers, unread] = await Promise.all([
    pool.query<{ id: string }>(`SELECT DISTINCT r."botId"::text AS id FROM agent_runs r
      JOIN bots b ON b.id=r."botId" AND b."ownerId"=$1 AND b."workspaceId"=$2
      WHERE r."userId"=$1 AND r.status='waiting_input' AND r."createdAt" > now() - interval '30 days'`, [userId, workspaceId]),
    pool.query<{ id: string }>(`SELECT DISTINCT p."botId"::text AS id FROM pending_actions p
      JOIN bots b ON b.id=p."botId" AND b."ownerId"=$1 AND b."workspaceId"=$2
      WHERE p."userId"=$1 AND p.status='pending'`, [userId, workspaceId]),
    pool.query<{ id: string }>(`SELECT d."botId"::text AS id FROM bot_desktops d
      JOIN bots b ON b.id=d."botId" AND b."ownerId"=$1 AND b."workspaceId"=$2
      WHERE d."ownerId"=$1 AND d.control='user' AND (d."controlUntil" IS NULL OR d."controlUntil" > now())`, [userId, workspaceId]),
    pool.query<{ id: string; unread: number }>(`SELECT m."botId"::text AS id, count(*)::int AS unread FROM (
        SELECT cm."botId", cm.position, cm.message->>'role' AS role,
               lag(cm.message->>'role') OVER (PARTITION BY cm."botId" ORDER BY cm.position) AS prev
        FROM coordinator_messages cm
        JOIN bots b ON b.id=cm."botId" AND b."ownerId"=$1 AND b."workspaceId"=$2
        WHERE cm."userId"=$1 AND cm.message->>'role' IN ('user', 'assistant')
      ) m
      LEFT JOIN conversation_reads cr ON cr."userId"=$1 AND cr."conversationId" = CASE
        WHEN m."botId" = (SELECT cb."botId" FROM coordinator_bots cb WHERE cb."ownerId"=$1 AND cb."workspaceId"=$2)
        THEN 'coordinator' ELSE 'bot:' || m."botId"::text END
      WHERE m.role='assistant' AND m.prev IS DISTINCT FROM 'assistant' AND m.position > COALESCE(cr."lastReadPosition", 0)
      GROUP BY m."botId"`, [userId, workspaceId]),
  ])
  const question = new Set(questions.rows.map(row => row.id))
  const approval = new Set(approvals.rows.map(row => row.id))
  const takeover = new Set(takeovers.rows.map(row => row.id))
  const counts = new Map(unread.rows.map(row => [row.id, Number(row.unread)]))
  const ids = new Set([...question, ...approval, ...takeover, ...counts.keys()])
  return new Map([...ids].map(id => [id, chatMark({
    question: question.has(id), approval: approval.has(id), takeover: takeover.has(id), unread: counts.get(id) ?? 0,
  })]))
}
