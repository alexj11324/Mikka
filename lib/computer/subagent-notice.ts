import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'

/** Enqueue one chat update per milestone. The internal Coordinator computer
 * identity maps back to the built-in null-bot chat. */
export async function subagentNotice(pool: Pool, actor: { userId: string; workspaceId: string }, botId: string, subagentId: string, milestone: string, details: { state: string; result?: string; needs?: string }) {
  const result = await pool.query(`INSERT INTO coordinator_events (id,"userId","botId",kind,"dedupeKey",payload,tier)
    SELECT $1,s."ownerId",CASE WHEN c."botId" IS NULL THEN s."botId" ELSE NULL END,'subagent_update',$5,jsonb_build_object('task',s.task) || $6::jsonb,'attention'
    FROM bot_subagents s LEFT JOIN coordinator_web_bots c ON c."botId"=s."botId" AND c."ownerId"=s."ownerId" AND c."workspaceId"=s."workspaceId"
    WHERE s.id=$2 AND s."botId"=$3 AND s."ownerId"=$4 AND s."workspaceId"=$7 ON CONFLICT ("dedupeKey") DO NOTHING`,
  [randomUUID(), subagentId, botId, actor.userId, `subagent:${subagentId}:${milestone}`, JSON.stringify({ subagentId, ...details }), actor.workspaceId])
  if (result.rowCount && (process.env.MIKKA_NATIVE_COORDINATOR === '1' || process.env.VERCEL === '1' || process.env.AI_GATEWAY_API_KEY)) {
    await (await import('@/lib/coordinator/wake')).wakeCoordinator(actor.userId)
  }
}
