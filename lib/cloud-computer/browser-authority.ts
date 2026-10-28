import 'server-only'
import { randomUUID } from 'node:crypto'
import { browserActionDigest } from './browser-action-receipt'
import { ComputerError } from '@/lib/computer/store'
import type { Actor } from './subagents'
import type { BrowserMutation } from './action-reviews'
import { effectiveWebComputerPermission, resolveWorkspaceComputerPolicy } from './workspace-policy'
import { runtimeRequest } from './runtime'

type Request = { actor: Actor; botId: string; subagentId: string; epoch: number; loaderId: string; origin: string; mutation: BrowserMutation }
type Execution = Request & { actionId: string; digest: string; policyVersion: number; expiresAt: number }
export type BrowserAuthority = { decision: 'allow' | 'ask' | 'deny'; policyVersion: number; expiresAt: number; readOnly: boolean; review?: { actionId: string; digest: string; summary: string } }

function receipt(input: Execution, summary: string) {
  const signed = { actionId: input.actionId, workspaceId: input.actor.workspaceId, botId: input.botId, subagentId: input.subagentId, epoch: input.epoch, policyVersion: input.policyVersion, expiresAt: input.expiresAt, loaderId: input.loaderId, origin: input.origin, mutation: input.mutation, summary }
  return { ...signed, digest: browserActionDigest(input.actor.userId, signed) }
}

/** Resolve the server-owned run policy and persist one exact operation in the
 * existing approval ledger. The model chooses the action, never its permission. */
export async function authorizeBrowserAction(input: Request & { permissionAction: 'computer_use'; summary: string }): Promise<BrowserAuthority> {
  const { pool } = await import('@/lib/db')
  const { authorizeSubscriptionWorkspace } = await import('@/lib/subscription-runtime')
  await authorizeSubscriptionWorkspace(input.actor.userId, input.actor.workspaceId)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const workspace = await resolveWorkspaceComputerPolicy(client, input.actor.workspaceId)
    const row = (await client.query('SELECT * FROM bot_subagents WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "botId"=$4 FOR UPDATE', [input.subagentId, input.actor.userId, input.actor.workspaceId, input.botId])).rows[0]
    if (!row || row.status !== 'running' || row.epoch !== input.epoch) throw new ComputerError(409, 'Web run changed or stopped')
    const decision = effectiveWebComputerPermission(workspace.permission, row.runPolicy)
    if (decision === 'deny') throw new ComputerError(403, 'Browser action denied')
    // A concurrent workflow retry cannot mint a second operation while a
    // previous action has an unresolved result or is awaiting its decision.
    const pending = await client.query(`SELECT id FROM pending_actions WHERE "userId"=$1 AND action='browser_operation' AND input->>'subagentId'=$2 AND status IN ('pending','running') LIMIT 1`, [input.actor.userId, input.subagentId])
    if (pending.rowCount) throw new ComputerError(409, 'Browser action outcome pending')
    const expiresAt = Date.now() + 5 * 60_000
    const action = receipt({ ...input, actionId: randomUUID(), digest: '', policyVersion: workspace.version, expiresAt }, input.summary)
    await client.query('INSERT INTO pending_actions (id,"userId",action,input,status) VALUES ($1,$2,$3,$4,$5)', [action.actionId, input.actor.userId, 'browser_operation', JSON.stringify(action), decision === 'ask' ? 'pending' : 'running'])
    await client.query('COMMIT')
    return { decision, policyVersion: workspace.version, expiresAt, readOnly: false, review: { actionId: action.actionId, digest: action.digest, summary: action.summary } }
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

async function execute(input: Execution, reviewed: boolean) {
  const { pool } = await import('@/lib/db')
  const { SubagentStore } = await import('./subagents')
  const { authorizeSubscriptionWorkspace } = await import('@/lib/subscription-runtime')
  await authorizeSubscriptionWorkspace(input.actor.userId, input.actor.workspaceId)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const policy = await resolveWorkspaceComputerPolicy(client, input.actor.workspaceId)
    const row = (await client.query('SELECT * FROM bot_subagents WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "botId"=$4 FOR UPDATE', [input.subagentId, input.actor.userId, input.actor.workspaceId, input.botId])).rows[0]
    if (!row || row.epoch !== input.epoch || row.status !== (reviewed ? 'needs_you' : 'running') || input.expiresAt <= Date.now() || input.policyVersion !== policy.version) throw new ComputerError(409, 'Web run or policy changed')
    const decision = effectiveWebComputerPermission(policy.permission, row.runPolicy)
    if (decision === 'deny' || (!reviewed && decision !== 'allow')) throw new ComputerError(403, 'Browser action denied')
    if (reviewed && (row.needs?.kind !== 'approval' || row.needs.actionId !== input.actionId)) throw new ComputerError(409, 'Browser action changed')
    const stored = (await client.query(`SELECT input FROM pending_actions WHERE id=$1 AND "userId"=$2 AND action='browser_operation' AND status='running' AND context IS NULL`, [input.actionId, input.actor.userId])).rows[0]?.input
    if (!stored) throw new ComputerError(409, 'Browser action already consumed')
    const expected = receipt(input, stored.summary)
    if (expected.digest !== input.digest || stored.digest !== input.digest) throw new ComputerError(409, 'Browser action changed')
    const { sandboxId } = await new SubagentStore(pool).machine(input.actor, input.botId, input.subagentId, client)
    // This CAS commits independently while the policy/run fence stays held.
    // A lost response or I/O failure never rolls the action back to executable.
    const consumed = await pool.query(`UPDATE pending_actions SET context='{"browserExecuting":true}'::jsonb WHERE id=$1 AND "userId"=$2 AND action='browser_operation' AND status='running' AND context IS NULL AND input=$3::jsonb RETURNING id`, [input.actionId, input.actor.userId, JSON.stringify(expected)])
    if (!consumed.rowCount) throw new ComputerError(409, 'Browser action already consumed or changed')
    const result = await runtimeRequest(sandboxId, row, '/action', { ...input.mutation, expectedLoaderId: input.loaderId, expectedOrigin: input.origin })
    if (!reviewed) await pool.query(`UPDATE pending_actions SET status='done',result=$3 WHERE id=$1 AND "userId"=$2 AND context='{"browserExecuting":true}'::jsonb`, [input.actionId, input.actor.userId, { accepted: result.accepted === true }])
    await client.query('COMMIT')
    return { accepted: result.accepted === true }
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}
export const executeAuthorizedBrowserAction = (input: Execution) => execute(input, false)
export const executeReviewedBrowserAction = (input: Execution) => execute(input, true)
export async function executeAuthorizedBrowserNavigation(input: { permissionAction: 'computer_use'; actor: Actor; botId: string; subagentId: string; epoch: number; url: string }) {
  const { pool } = await import('@/lib/db')
  const { browserAction } = await import('./action-reviews')
  return browserAction(pool, input.actor, input.botId, input.subagentId, { action: 'navigate', url: input.url }, `Navigate to ${new URL(input.url).origin}`)
}
