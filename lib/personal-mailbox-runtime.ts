import { createHash } from 'node:crypto'
import 'server-only'
import { pool } from '@/lib/db'
import { WORKSPACE_ID } from '@/lib/device-link'
import { SessionMailbox } from './session-mailbox'
import { nativeMailboxFence, workerMailboxFence, type PersonalNativeScope } from './personal-mailbox-fence'
import { personalMailboxRequest, personalMailboxAction } from './personal-mailbox-action'
import { personalWorkerMailboxSupported } from './personal-mailbox-capability'
import { mailboxGrantTools } from './personal-mailbox-grant'
import type { WorkerDefinitionSnapshot } from './agent-kit/worker'
import type { MailboxToolName } from '@mikka/protocol/mailbox'
import { MailboxError } from './mailbox-error'
import { agentScope } from './agent-kit/service'
import type { PoolClient } from 'pg'
import { personalMailboxEnabled } from './personal-mailbox-config'
import { workspacePool } from './workspace-db'
import { acquireWorkspaceMembership } from './workspace-membership-guard'
import type { MailboxTransactionGuard } from './mailbox-transaction-guard'
export { personalMailboxEnabled } from './personal-mailbox-config'

// Both personal Coordinator and Bot calls get cancellation/deadline custody.
// This guard is not a grant: authorize() holds the actual APP authority rows.
function authorityGuard(userId: string, botId: string | null, workspaceId: string, authorize: (client: PoolClient) => Promise<void>, signal?: AbortSignal): MailboxTransactionGuard {
  return Object.assign(async (client: PoolClient, abort: AbortSignal) => {
    await authorize(client)
    if (botId) return acquireWorkspaceMembership(workspacePool, { userId, workspaceId }, abort)
    return { signal: abort, async check() { if (abort.aborted) throw new MailboxError('Mailbox authority cancelled', 403) }, async close() {} }
  }, { signal })
}

// Default-off until the separately reviewed personal schema is installed and
// acceptance is approved. This code does not change deployment configuration.
async function workerRecord(userId: string, runId: string) {
  const { rows: [run] } = await pool.query('select r."botId",r."deviceId",r."agentId",r.status,r."stopRequestedAt",r."leaseExpiresAt",b."workspaceId",coalesce(to_jsonb(r)->\'agentDefinition\'->>\'harness\',a.harness) as harness,to_jsonb(r)->\'agentDefinition\' as "agentDefinition" from agent_runs r join agents a on a.id=r."agentId" and a."userId"=r."userId" join devices d on d.id=r."deviceId" and d."ownerId"=r."userId" and d.enabled left join bots b on b.id=r."botId" and b."ownerId"=r."userId" where r.id=$1 and r."userId"=$2', [runId, userId])
  return run
}
async function assertMailboxScope(userId: string, botId: string | null, workspaceId: string, client?: PoolClient, workspaceClient?: Pick<PoolClient, 'query'>) {
  try {
    const scope = await agentScope(userId, botId, client, workspaceClient)
    if (botId && scope.workspaceId !== workspaceId) throw new Error('Scope changed')
  } catch { throw new MailboxError('Mailbox owner/workspace scope revoked', 403) }
}
export async function personalConversationMailboxAdvertised(userId: string, botId: string | null, executionId?: string): Promise<MailboxToolName[]> {
  if (!personalMailboxEnabled() || !executionId) return []
  try {
    const scope = await agentScope(userId, botId)
    return await mailboxGrantTools(pool, { userId, botId, workspaceId: scope.workspaceId ?? WORKSPACE_ID, executionId })
  } catch (error) { if (error instanceof MailboxError || (error instanceof Error && error.message === 'agentScopeNotFound')) return []; throw error }
}
/** The authenticated MCP router chooses its catalogue from host records,
 * independently of model arguments. A global flag cannot widen old snapshots. */
export async function personalWorkerMailboxAdvertised(userId: string, runId: string): Promise<MailboxToolName[]> {
  if (!personalMailboxEnabled()) return []
  const run = await workerRecord(userId, runId)
  const lease = run?.leaseExpiresAt == null ? NaN : new Date(run.leaseExpiresAt).getTime()
  const valid = Boolean(run?.deviceId && (!run.botId || run.workspaceId) && !run.stopRequestedAt && Number.isFinite(lease) && lease > Date.now()
    && ['queued', 'preparing', 'running', 'waiting_input', 'finishing'].includes(run.status)
    && personalWorkerMailboxSupported(run.harness, run.agentDefinition))
  if (!valid) return []
  try { await assertMailboxScope(userId, run.botId, run.workspaceId ?? WORKSPACE_ID)
    return await mailboxGrantTools(pool, { userId, botId: run.botId, workspaceId: run.workspaceId ?? WORKSPACE_ID,
    executionId: run.agentDefinition.parent.executionId, worker: run.agentDefinition }) }
  catch (error) { if (error instanceof MailboxError) return []; throw error }
}
export async function personalWorkerMailbox(userId: string, runId: string, input: unknown, verifiedToken: string, signal?: AbortSignal) {
  if (!personalMailboxEnabled()) return { status: 503, body: { error: 'personal_mailbox_unavailable' } }
  // Resolve the existing private Bot namespace from trusted records, never a
  // body field. Unbound runs retain main's existing device namespace.
  const run = await workerRecord(userId, runId)
  if (!run || !run.deviceId || (run.botId && !run.workspaceId)) return { status: 403, body: { error: 'Run namespace unavailable' } }
  if (!personalWorkerMailboxSupported(run.harness, run.agentDefinition)) return { status: 409, body: { error: 'Worker mailbox capability is not frozen for this runtime' } }
  const namespace = run.workspaceId ?? WORKSPACE_ID
  const tokenHash = createHash('sha256').update(verifiedToken).digest('hex')
  const parsed = personalMailboxRequest.safeParse(input)
  if (!parsed.success) return { status: 400, body: { error: 'Invalid mailbox request' } }
  const fence = workerMailboxFence({ userId, runId, botId: run.botId, deviceId: run.deviceId, agentId: run.agentId, workspaceId: namespace, tokenHash,
    snapshot: run.agentDefinition as WorkerDefinitionSnapshot, tool: `mailbox_${parsed.data.action}` }, personalMailboxEnabled)
  const guard = authorityGuard(userId, run.botId, namespace, fence, signal)
  const store = new SessionMailbox(pool, namespace, async (client, lease) => { await assertMailboxScope(userId, run.botId, namespace, client, lease?.workspaceClient); await fence(client); await assertMailboxScope(userId, run.botId, namespace, client, lease?.workspaceClient) }, guard)
  return personalMailboxAction(input, { enabled: true, store, actor: () => store.run(userId, runId, tokenHash) })
}
/** Host-only seam for an actual Coordinator/private Bot context. It is not
 * exposed as a caller-selected source mailbox in the public request schema. */
export async function personalConversationMailbox(userId: string, botId: string | null, input: unknown, scope?: PersonalNativeScope, executionId?: string, signal?: AbortSignal) {
  if (!personalMailboxEnabled()) return { status: 503, body: { error: 'personal_mailbox_unavailable' } }
  const parsed = personalMailboxRequest.safeParse(input)
  if (!parsed.success) return { status: 400, body: { error: 'Invalid mailbox request' } }
  if (!executionId) return { status: 403, body: { error: 'Explicit definition mailbox grant required' } }
  let namespace = WORKSPACE_ID
  if (botId) {
    const { rows: [bot] } = await pool.query('select "workspaceId" from bots where id=$1 and "ownerId"=$2', [botId, userId])
    if (!bot) return { status: 404, body: { error: 'Unknown private Bot' } }
    namespace = bot.workspaceId
  }
  const nativeFence = scope ? nativeMailboxFence({ userId, botId, workspaceId: namespace, scope, action: parsed.data.action }, personalMailboxEnabled) : undefined
  const appFence = async (client: PoolClient) => {
    if (!personalMailboxEnabled()) throw new MailboxError('personal_mailbox_unavailable', 503)
    await nativeFence?.(client)
    if (botId && !(await client.query('SELECT id FROM bots WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3 FOR SHARE', [botId, userId, namespace])).rowCount) throw new MailboxError('Mailbox Bot scope unavailable', 403)
    const tools = await mailboxGrantTools(client, { userId, botId, workspaceId: namespace, executionId }, true)
    if (!tools.includes(`mailbox_${parsed.data.action}`)) throw new MailboxError('Mailbox tool grant revoked', 403)
  }
  const fence: import('./personal-mailbox-fence').MailboxFence = async (client, lease) => {
    await assertMailboxScope(userId, botId, namespace, client, lease?.workspaceClient)
    await appFence(client)
    await assertMailboxScope(userId, botId, namespace, client, lease?.workspaceClient)
  }
  const guard = authorityGuard(userId, botId, namespace, appFence, signal)
  const store = new SessionMailbox(pool, namespace, fence, guard)
  return personalMailboxAction(input, { enabled: true, store, actor: () => store.conversation(userId, botId ? 'bot' : 'coordinator', botId ?? 'coordinator') })
}
