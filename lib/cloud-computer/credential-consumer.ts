import 'server-only'
import type { Pool } from 'pg'
import { ComputerError } from '@/lib/computer/store'
import type { Actor } from './subagents'
import { newCredentialActionId, parseCredentialAction, recordCredentialAction, type CredentialAction } from './credential-action-ledger'
import { effectiveWebComputerPermission, resolveWorkspaceComputerPolicy } from './workspace-policy'
import { runtimeRequest } from './runtime'
import { credentialServiceOutcome, executeRecordedCredentialAction } from './credential-service'

/** #345 must validate owner, origin, loader, backend node identity against the
 * live bound target/session, and secret isolation. The node ID is an observed
 * CDP identity, not code and not authority. The host must apply and consume
 * computer_use before any action.
 * The model supplies neither credentials nor a permission decision. */
export async function executeCredentialIntent(input: { permissionAction: 'computer_use'; actor: Actor; botId: string; subagentId: string; epoch: number; targetId: string; loaderId: string; origin: string; backendNodeId: number; intent: { targetSelector: string; role: 'username' | 'password' } }): Promise<{ status: 'needs_login' | 'session_applied' | 'submitted' | 'guarded' } | { status: 'needs_you'; actionId: string; summary: string }> {
  const { pool } = await import('@/lib/db')
  const { SubagentStore } = await import('./subagents')
  const { authorizeSubscriptionWorkspace } = await import('@/lib/subscription-runtime')
  await authorizeSubscriptionWorkspace(input.actor.userId, input.actor.workspaceId)
  const client = await pool.connect()
  let action: CredentialAction
  try {
    await client.query('BEGIN')
    const workspace = await resolveWorkspaceComputerPolicy(client, input.actor.workspaceId)
    const row = (await client.query(`SELECT * FROM bot_subagents WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3 AND "botId"=$4 FOR UPDATE`, [input.subagentId, input.actor.userId, input.actor.workspaceId, input.botId])).rows[0]
    if (!row || row.status !== 'running' || row.epoch !== input.epoch || row.targetId !== input.targetId) throw new ComputerError(409, 'Web run changed or stopped')
    const decision = effectiveWebComputerPermission(workspace.permission, row.runPolicy)
    if (decision === 'deny') throw new ComputerError(403, 'Computer action denied')
    const { sandboxId } = await new SubagentStore(pool).machine(input.actor, input.botId, input.subagentId, client)
    const current = await runtimeRequest(sandboxId, row, '/action', { action: 'inspectCredentialTarget', loaderId: input.loaderId, origin: input.origin, backendNodeId: input.backendNodeId, role: input.intent.role })
    if (current.targetId !== input.targetId || current.loaderId !== input.loaderId || current.origin !== input.origin || current.backendNodeId !== input.backendNodeId || current.role !== input.intent.role) throw new ComputerError(409, 'Credential target changed')
    const outstanding = (await client.query(`SELECT input,status FROM pending_actions WHERE "userId"=$1 AND action='browser_operation' AND input->>'kind'='browser_credential' AND input->>'subagentId'=$2 AND status IN ('pending','running') LIMIT 2`, [input.actor.userId, input.subagentId])).rows
    if (outstanding.length) {
      if (outstanding.length !== 1 || outstanding[0].status !== 'pending') throw new ComputerError(409, 'Credential action outcome pending')
      action = parseCredentialAction(outstanding[0].input)
      if (action.admission !== decision || action.policyVersion !== workspace.version || action.epoch !== input.epoch || action.targetId !== input.targetId || action.loaderId !== input.loaderId || action.origin !== input.origin || action.backendNodeId !== input.backendNodeId || action.role !== input.intent.role) throw new ComputerError(409, 'Credential action changed')
    } else {
      action = (await recordCredentialAction(client, { userId: input.actor.userId, workspaceId: input.actor.workspaceId, botId: input.botId, subagentId: input.subagentId, runId: input.subagentId, epoch: input.epoch, policyVersion: workspace.version, targetId: input.targetId, origin: input.origin, loaderId: input.loaderId, backendNodeId: input.backendNodeId, role: input.intent.role, expiresAt: Date.now() + 5 * 60_000 }, decision, row.runPolicy.readOnly === true, newCredentialActionId())).action
    }
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  if (action.admission === 'ask') return { status: 'needs_you', actionId: action.actionId, summary: action.summary }
  // The transaction has ended. The service owns the I/O fence and durable
  // consumption, avoiding cross-process advisory-lock deadlocks.
  const result = credentialServiceOutcome(await executeRecordedCredentialAction(action))
  await pool.query(`UPDATE pending_actions SET status='done',result=$3 WHERE id=$1 AND "userId"=$2 AND action='browser_operation' AND status='running' AND context='{"credentialExecuting":true}'::jsonb`, [action.actionId, action.userId, { status: result.status }])
  return result
}

/** Called only by the existing pending action dispatcher after its atomic
 * pending -> running/declined transition; approval is never model supplied. */
export async function executeApprovedCredentialAction(pool: Pool, userId: string, raw: unknown, approved: boolean, receiptId?: string): Promise<{ data: Record<string, unknown> } | { error: string }> {
  try {
    const action = parseCredentialAction(raw as CredentialAction)
    if (action.userId !== userId || action.actionId !== receiptId || action.admission !== 'ask') return { error: 'browserActionChanged' }
    const { authorizeSubscriptionWorkspace } = await import('@/lib/subscription-runtime')
    await authorizeSubscriptionWorkspace(userId, action.workspaceId)
    const { SubagentStore } = await import('./subagents')
    const store = new SubagentStore(pool)
    const actor = { userId, workspaceId: action.workspaceId }
    const row = await store.get(actor, action.botId, action.subagentId)
    if (row.status !== 'needs_you' || row.epoch !== action.epoch || row.targetId !== action.targetId || row.needs?.kind !== 'approval' || row.needs.actionId !== action.actionId) return { error: 'browserActionExpired' }
    if (!approved) { await store.stop(actor, action.botId, action.subagentId); return { data: {} } }
    // The service must consume this exact running record and recheck current
    // permission and target under its own I/O lock. Never self-certify it here.
    const result = credentialServiceOutcome(await executeRecordedCredentialAction(action))
    if (result.status === 'guarded') await store.update(actor, action.botId, action.subagentId, 'needs_you', 'Secure login continuation unavailable')
    else if (result.status === 'needs_login') await store.update(actor, action.botId, action.subagentId, 'needs_you', 'needs_you', { kind: 'login', site: action.origin })
    else await store.update(actor, action.botId, action.subagentId, 'running', 'running')
    return { data: result }
  } catch (error) {
    if (error instanceof ComputerError && error.status === 503) return { error: 'browserCredentialServiceUnavailable' }
    return { error: 'browserActionOutcomeUnknown' }
  }
}
