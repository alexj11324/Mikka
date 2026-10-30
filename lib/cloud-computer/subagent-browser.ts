import 'server-only'
import { pool } from '@/lib/db'
import { connectComputer } from '@/lib/computer/e2b-provider'
import { grant, runtimeRequest } from './runtime'
import { z } from 'zod'
const observationSchema = z.object({ targetId: z.string().min(1), origin: z.string().url(), loaderId: z.string().min(1), inputs: z.array(z.object({ backendNodeId: z.number().int().positive(), credentialRole: z.enum(['username', 'password']) }).strict()).min(1).max(2) }).strict()

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
  const observation = observationSchema.parse(await runtimeRequest(row.sandboxId, row, '/credentials/observe'))
  if (observation.targetId !== row.targetId || observation.origin !== parsed.origin || new Set(observation.inputs.map(item => item.credentialRole)).size !== observation.inputs.length || !observation.inputs.some(item => item.credentialRole === 'password')) throw new Error('Credential target unavailable')
  const policy = (await pool.query('SELECT permission,version FROM workspace_computer_policies WHERE "workspaceId"=$1', [input.workspaceId])).rows[0]
  if (policy?.permission === 'deny') throw new Error('Credential target unavailable')
  const observedInputs = observation.inputs.map(item => ({ ...item, loaderId: observation.loaderId, epoch: Number(row.epoch), permissionVersion: Number(policy?.version ?? 0) }))
  const capability = await grant(await connectComputer(input.workspaceId, row.sandboxId), row, 'broker')
  return { targetId: row.targetId as string, origin: parsed.origin, observedInputs, ...capability }
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
  return { targetId: row.targetId as string, origin: url.origin, ...await grant(await connectComputer(input.workspaceId, row.sandboxId), binding, 'broker') }
}
