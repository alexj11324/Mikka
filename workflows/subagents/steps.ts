import { start } from 'workflow/api'
import { pool } from '@/lib/db'
import { SubagentQueue, type Subagent } from '@/lib/computer/subagent-queue'
import { SubagentApprovals, type BrowserAction } from '@/lib/computer/subagent-approval'
import { subagentNotice } from '@/lib/computer/subagent-notice'
import * as provider from '@/lib/computer/e2b-provider'
import { ensureBotMachine } from '@/lib/computer/bot-machine'
import { botWebWorker } from './workflow'

type Actor = { userId: string; workspaceId: string }

export async function claim(actor: Actor, workerKey: string) {
  'use step'
  return new SubagentQueue(pool).claimNext(actor, workerKey)
}

/** Start under the same lock used by policy changes, takeover and stop. */
export async function boot(actor: Actor, task: Subagent) {
  'use step'
  await (await import('@/lib/subscription-runtime')).authorizeSubscriptionWorkspace(actor.userId, actor.workspaceId)
  const sandbox = await ensureBotMachine(pool, actor, task.botId)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`computer-policy:${actor.workspaceId}`])
    const row = (await client.query(`SELECT s.*,p.permission,p.version FROM bot_subagents s LEFT JOIN workspace_computer_policies p ON p."workspaceId"=s."workspaceId"
      WHERE s.id=$1 AND s."botId"=$2 AND s."ownerId"=$3 AND s."workspaceId"=$4 FOR UPDATE OF s`, [task.id, task.botId, actor.userId, actor.workspaceId])).rows[0]
    if (!row || row.stopRequestedAt || row.haltedAt || !['running','needs_you'].includes(row.state) || row.permission === 'deny') throw new Error('Web task unavailable')
    await provider.installSubagentRuntime(sandbox)
    await provider.syncSubagentLease(sandbox, { subagentId: task.id, botId: task.botId, ownerId: actor.userId, workspaceId: actor.workspaceId,
      epoch: row.epoch, controlledBy: row.controlledBy, controlUntil: row.controlUntil ? new Date(row.controlUntil).getTime() / 1000 : 0,
      computerAllowed: true, policyVersion: row.version ?? 0, stopRequested: false })
    await provider.startSubagentBrowser(sandbox, task.id)
    await client.query('UPDATE bot_subagents SET "browserContextId"=$2 WHERE id=$1', [task.id, task.id])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

export async function requestApproval(actor: Actor, task: Subagent, operationKey: string, action: BrowserAction) {
  'use step'
  const review = await new SubagentApprovals(pool).request(actor, task.botId, task.id, operationKey, action)
  if (review.state === 'pending') await subagentNotice(pool, actor, task.botId, task.id, `approval:${review.id}`, { state: 'needs_you', needs: `Approval required: ${action.action}` })
  return { ...review, expiresAt: new Date(review.expiresAt).toISOString() }
}

export async function approvalStatus(actor: Actor, task: Subagent, id: string, digest: string) {
  'use step'
  return await new SubagentApprovals(pool).status(actor, task.botId, task.id, id, digest) ?? { state: 'denied', result: null }
}

/** An approval is consumed before the action. If the response is lost, a
 * retry observes executing/uncertain and never repeats the external action. */
export async function performApproved(actor: Actor, task: Subagent, id: string, digest: string) {
  'use step'
  const approvals = new SubagentApprovals(pool)
  const action = await approvals.consume(actor, task.botId, task.id, id, digest)
  if (!action) {
    const status = await approvals.status(actor, task.botId, task.id, id, digest)
    if (status?.state === 'completed') return { result: status.result }
    if (status?.state === 'executing') {
      await approvals.complete(actor, task.botId, task.id, id, digest, null, true)
      await pool.query(`UPDATE bot_subagents SET "haltedAt"=coalesce("haltedAt",now()),needs=$2 WHERE id=$1 AND "ownerId"=$3`, [task.id, 'The action outcome is unknown; check the page before trying again.', actor.userId])
      return { error: 'actionOutcomeUnknown' }
    }
    return { error: 'actionUnavailable' }
  }
  try {
    const row = (await pool.query(`SELECT s.*,m."sandboxId",p.permission,p.version FROM bot_subagents s
      JOIN cloud_machines m ON m."workspaceId"=s."workspaceId" AND m."ownerId"=s."ownerId"
      LEFT JOIN workspace_computer_policies p ON p."workspaceId"=s."workspaceId"
      WHERE s.id=$1 AND s."botId"=$2 AND s."ownerId"=$3 AND s."workspaceId"=$4`, [task.id, task.botId, actor.userId, actor.workspaceId])).rows[0]
    if (!row || !row.sandboxId || row.permission === 'deny' || row.stopRequestedAt) throw new Error('Web task unavailable')
    const sandbox = await provider.connectComputer(row.sandboxId)
    const lease: provider.SubagentLease = { subagentId: task.id, botId: task.botId, ownerId: actor.userId, workspaceId: actor.workspaceId,
      epoch: row.epoch, controlledBy: row.controlledBy, controlUntil: row.controlUntil ? new Date(row.controlUntil).getTime() / 1000 : 0,
      computerAllowed: true, policyVersion: row.version ?? 0, stopRequested: false }
    const result = await provider.subagentBrowserAction(sandbox, lease, action)
    await approvals.complete(actor, task.botId, task.id, id, digest, result)
    return { result }
  } catch {
    await approvals.complete(actor, task.botId, task.id, id, digest, null, true)
    await pool.query(`UPDATE bot_subagents SET "haltedAt"=coalesce("haltedAt",now()),needs=$2 WHERE id=$1 AND "ownerId"=$3`, [task.id, 'The action outcome is unknown; check the page before trying again.', actor.userId])
    return { error: 'actionOutcomeUnknown' }
  }
}

export async function finish(actor: Actor, task: Subagent, outcome: 'done' | 'failed', result: string) {
  'use step'
  const row = (await pool.query(`SELECT s.state,s."browserContextId",m."sandboxId" FROM bot_subagents s
    LEFT JOIN cloud_machines m ON m."workspaceId"=s."workspaceId" AND m."ownerId"=s."ownerId"
    WHERE s.id=$1 AND s."botId"=$2 AND s."ownerId"=$3 AND s."workspaceId"=$4`, [task.id, task.botId, actor.userId, actor.workspaceId])).rows[0]
  if (!row) return
  if (['running','needs_you'].includes(row.state)) {
    const reviews = (await pool.query(`SELECT count(*) FILTER (WHERE state='completed')::int AS completed,
      count(*) FILTER (WHERE state IN ('denied','uncertain','executing') OR (state IN ('pending','approved') AND "expiresAt"<=now()))::int AS failed
      FROM bot_subagent_approvals WHERE "subagentId"=$1 AND "ownerId"=$2`, [task.id, actor.userId])).rows[0]
    if (!reviews.completed || reviews.failed) outcome = 'failed'
    if (row.sandboxId) await provider.stopSubagentBrowser(await provider.connectComputer(row.sandboxId), task.id)
    await pool.query('UPDATE bot_subagents SET result=$2 WHERE id=$1 AND "ownerId"=$3', [task.id, result.slice(0, 10_000), actor.userId])
    await new SubagentQueue(pool).finish(actor, task.botId, task.id, outcome)
  }
  const current = (await pool.query('SELECT state,result FROM bot_subagents WHERE id=$1 AND "ownerId"=$2', [task.id, actor.userId])).rows[0]
  if (current && ['done','failed','stopped'].includes(current.state)) await subagentNotice(pool, actor, task.botId, task.id, 'finished', { state: current.state, ...(current.result ? { result: current.result } : {}) })
}

export async function startNext(actor: Actor) {
  'use step'
  const queued = await pool.query(`SELECT 1 FROM bot_subagents WHERE "ownerId"=$1 AND "workspaceId"=$2 AND state='queued' LIMIT 1`, [actor.userId, actor.workspaceId])
  if (queued.rowCount) await start(botWebWorker, [actor])
}
