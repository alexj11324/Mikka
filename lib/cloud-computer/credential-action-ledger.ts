import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { z } from 'zod'
import { ComputerError } from '@/lib/computer/store'

// This is an action receipt in the existing approval ledger, not an
// authorization source. The caller must resolve the run's policy itself.
const bindingSchema = z.object({
  userId: z.string().min(1), workspaceId: z.uuid(), botId: z.uuid(), subagentId: z.uuid(),
  runId: z.uuid(), epoch: z.number().int().nonnegative(), policyVersion: z.number().int().nonnegative(),
  targetId: z.string().min(1), origin: z.string().url(), loaderId: z.string().min(1),
  backendNodeId: z.number().int().positive(), role: z.enum(['username', 'password']),
  expiresAt: z.number().int().positive(),
}).strict()
export type CredentialActionBinding = z.infer<typeof bindingSchema>
export type CredentialAction = CredentialActionBinding & { kind: 'browser_credential'; actionId: string; digest: string; summary: string }
function digest(binding: CredentialActionBinding, actionId: string) {
  return createHash('sha256').update(JSON.stringify([actionId, binding.userId, binding.workspaceId, binding.botId, binding.subagentId, binding.runId, binding.epoch, binding.policyVersion, binding.targetId, binding.origin, binding.loaderId, binding.backendNodeId, binding.role, binding.expiresAt])).digest('hex')
}

/** The host persists this id with its workflow step before attempting I/O. */
export const newCredentialActionId = () => randomUUID()

/** The decision and stable id must come from the authenticated host, never model input. */
export async function recordCredentialAction(pool: Pool, raw: CredentialActionBinding, decision: 'allow' | 'ask' | 'deny', readOnly: boolean, actionId: string) {
  const binding = bindingSchema.parse(raw)
  const origin = new URL(binding.origin)
  if (origin.protocol !== 'https:' || origin.origin !== binding.origin || origin.username || origin.password || binding.expiresAt <= Date.now()) throw new ComputerError(403, 'Credential action unavailable')
  if (readOnly || decision === 'deny' || !['allow', 'ask'].includes(decision)) throw new ComputerError(403, 'Credential action denied')
  // The persisted web subagent is this workflow's run; do not bind an
  // unrelated daemon agent_runs record merely to obtain an action id.
  if (binding.runId !== binding.subagentId) throw new ComputerError(403, 'Credential action unavailable')
  if (!z.uuid().safeParse(actionId).success) throw new ComputerError(403, 'Credential action unavailable')
  const summary = `Fill ${binding.role} on ${origin.hostname}`
  const action: CredentialAction = { ...binding, kind: 'browser_credential', actionId, digest: digest(binding, actionId), summary }
  // The regular decision handler consumes pending -> running for ask. Allow
  // starts at running; both paths must atomically claim it before any I/O.
  const inserted = await pool.query('INSERT INTO pending_actions (id,"userId",action,input,status) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING RETURNING id', [actionId, binding.userId, 'browser_operation', JSON.stringify(action), decision === 'ask' ? 'pending' : 'running'])
  if (!inserted.rowCount) {
    const existing = await pool.query('SELECT id FROM pending_actions WHERE id=$1 AND "userId"=$2 AND action=\'browser_operation\' AND input=$3::jsonb', [actionId, binding.userId, JSON.stringify(action)])
    if (!existing.rowCount) throw new ComputerError(409, 'Credential action changed')
  }
  return { action, decision }
}

/** Claim durably before I/O. Current policy, run and target must be rechecked
 * while holding their existing fence before invoking the credential service. */
export async function consumeCredentialAction(pool: Pool, raw: CredentialAction) {
  const { kind, actionId, digest: expected, summary, ...rawBinding } = raw
  const binding = bindingSchema.parse(rawBinding)
  if (kind !== 'browser_credential' || !z.uuid().safeParse(actionId).success || summary !== `Fill ${binding.role} on ${new URL(binding.origin).hostname}` || digest(binding, actionId) !== expected || binding.expiresAt <= Date.now()) throw new ComputerError(403, 'Credential action unavailable')
  const result = await pool.query(`UPDATE pending_actions SET context='{"credentialClaimed":true}'::jsonb WHERE id=$1 AND "userId"=$2 AND action='browser_operation' AND status='running' AND context IS NULL AND input=$3::jsonb AND "createdAt">clock_timestamp()-interval '5 minutes' RETURNING id`, [actionId, binding.userId, JSON.stringify(raw)])
  if (!result.rowCount) throw new ComputerError(409, 'Credential action already consumed or unavailable')
  return raw
}

/** Hold the same workspace policy lock used by policy changes while rechecking
 * the owner-bound web run and executing the exact already-claimed action.
 * The callback must recheck the live CDP target before any credential I/O. */
export async function withCredentialActionFence<T>(pool: Pool, action: CredentialAction, execute: (sandboxId: string) => Promise<T>) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${action.workspaceId}`])
    const row = (await client.query(`SELECT m."sandboxId",COALESCE(p.permission,'ask') AS permission,COALESCE(p.version,0) AS version
      FROM pending_actions a
      JOIN bot_subagents s ON s.id=$4 AND s."ownerId"=$2 AND s."workspaceId"=$3 AND s."botId"=$5
      JOIN bots bot ON bot.id=s."botId" AND bot."ownerId"=s."ownerId" AND bot."workspaceId"=s."workspaceId"
      JOIN cloud_machines m ON m."workspaceId"=s."workspaceId" AND m."ownerId"=s."ownerId" AND m.state='running'
      LEFT JOIN workspace_computer_policies p ON p."workspaceId"=s."workspaceId"
      WHERE a.id=$1 AND a."userId"=$2 AND a.action='browser_operation' AND a.status='running'
        AND a.context='{"credentialClaimed":true}'::jsonb AND a.input=$7::jsonb
        AND s.id=$6 AND s.status IN ('running','needs_you') AND s.epoch=$8 AND s."targetId"=$9
      FOR UPDATE OF s`, [action.actionId, action.userId, action.workspaceId, action.subagentId, action.botId, action.runId, JSON.stringify(action), action.epoch, action.targetId])).rows[0]
    if (!row || !['allow', 'ask'].includes(row.permission) || Number(row.version) !== action.policyVersion || !row.sandboxId || action.expiresAt <= Date.now()) throw new ComputerError(403, 'Credential action unavailable')
    // Commit the final one-use transition independently before the external
    // call, while this transaction still holds the policy and run fences.
    // A failure or lost response must never make the action replayable.
    const started = await pool.query(`UPDATE pending_actions SET context='{"credentialExecuting":true}'::jsonb WHERE id=$1 AND "userId"=$2 AND action='browser_operation' AND status='running' AND context='{"credentialClaimed":true}'::jsonb AND input=$3::jsonb RETURNING id`, [action.actionId, action.userId, JSON.stringify(action)])
    if (!started.rowCount) throw new ComputerError(409, 'Credential action already consumed or unavailable')
    const result = await execute(row.sandboxId as string)
    await client.query('COMMIT')
    return result
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
