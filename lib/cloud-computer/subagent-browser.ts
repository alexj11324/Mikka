import 'server-only'
import { pool } from '@/lib/db'
import { connectComputer } from '@/lib/computer/e2b-provider'
import { grant, runtimeRequest } from './runtime'

/** Broker contract. This binding is resolved exclusively from authenticated
 * owner/workspace/bot/subagent state; endpoints never enter model or UI data. */
export async function resolveSubagentBrowserTarget(input: { userId: string; workspaceId: string; botId: string; subagentId: string }) {
  const row = (await pool.query(`SELECT s.*,m."sandboxId" FROM bot_subagents s
    JOIN bots b ON b.id=s."botId" AND b."ownerId"=s."ownerId" AND b."workspaceId"=s."workspaceId"
    JOIN cloud_machines m ON m."workspaceId"=s."workspaceId" AND m."ownerId"=s."ownerId" AND m.state='running'
    WHERE s.id=$1 AND s."ownerId"=$2 AND s."workspaceId"=$3 AND s."botId"=$4
      AND s.status IN ('running','needs_you') AND s."targetId" IS NOT NULL`, [input.subagentId, input.userId, input.workspaceId, input.botId])).rows[0]
  if (!row?.sandboxId) throw new Error('Browser target unavailable')
  const state = await runtimeRequest(row.sandboxId, row, '/state')
  if (state.guarded || state.targetId !== row.targetId || typeof state.url !== 'string') throw new Error('Browser target unavailable')
  const parsed = new URL(state.url)
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('Browser target unavailable')
  const capability = await grant(await connectComputer(row.sandboxId), row, 'broker')
  return { targetId: row.targetId as string, origin: parsed.origin, ...capability }
}

export async function resolveThreadBrowserTarget(input: { userId: string; workspaceId: string; runId: string }) {
  const row = (await pool.query(`SELECT m.*,r."botId" FROM thread_machines m
    JOIN agent_runs r ON r.id=m."runId" AND r."userId"=m."ownerId"
    WHERE m."runId"=$1 AND m."ownerId"=$2 AND m."workspaceId"=$3 AND m.state='running'
      AND r.status IN ('running','waiting_input','preparing') AND r."stopRequestedAt" IS NULL`, [input.runId, input.userId, input.workspaceId])).rows[0]
  if (!row?.targetId || !row.sandboxId) throw new Error('Thread browser unavailable')
  const binding = { id: input.runId, ownerId: input.userId, workspaceId: input.workspaceId, botId: row.botId, epoch: row.epoch, display: 1 }
  const state = await runtimeRequest(row.sandboxId, binding, '/state')
  if (state.guarded || state.targetId !== row.targetId || typeof state.url !== 'string') throw new Error('Thread browser unavailable')
  const url = new URL(state.url)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Thread browser unavailable')
  return { targetId: row.targetId as string, origin: url.origin, ...await grant(await connectComputer(row.sandboxId), binding, 'broker') }
}
