import type { PoolClient } from 'pg'
import type { AgentExecution } from './agent-kit/store'
import type { WorkerDefinitionSnapshot } from './agent-kit/worker'
import { personalWorkerMailboxScopeMatches, personalWorkerMailboxTools } from './personal-mailbox-capability'
import { mailboxGrantTools } from './personal-mailbox-grant'
import { ActionFailureError } from './action-error'
import { MailboxError } from './mailbox-error'
import { CiContinuationUnsupported } from './ci-continuation-contract'

const invalid = (): never => { throw new CiContinuationUnsupported('mailbox') }

/** Recover the server-stored parent snapshot only for a previously frozen worker grant.
 * This read grants no authority: authorizeContinuationMailbox repeats its provenance and
 * current-head checks under the admission transaction before any run can be inserted. */
export async function continuationMailboxParent(client: PoolClient, userId: string, source: WorkerDefinitionSnapshot | null | undefined, enabled: boolean): Promise<AgentExecution | undefined> {
  if (!source?.mailbox) return undefined
  if (!enabled || !source.parent || !personalWorkerMailboxTools(source.harness, source).length) return invalid()
  const { rows: [execution] } = await client.query<AgentExecution>('SELECT id,snapshot,status FROM agent_kit_executions WHERE owner_id=$1 AND id=$2', [userId, source.parent.executionId])
  if (!execution || !execution.snapshot) return invalid()
  return execution
}

/** Recheck the exact original delegation and the current owner's head, with
 * SHARE locks retained until admission/claim commits. Never add newly granted tools. */
export async function authorizeContinuationMailbox(client: PoolClient, userId: string, botId: string | null, workspaceId: string, source: WorkerDefinitionSnapshot | null | undefined, child: WorkerDefinitionSnapshot | null | undefined, enabled: boolean): Promise<void> {
  if (!source?.mailbox && !child?.mailbox) return
  if (!enabled || !source || !child || !source.parent || !child.parent || source.definitionDigest !== child.definitionDigest ||
    source.parent.executionId !== child.parent.executionId || source.parent.revisionId !== child.parent.revisionId ||
    source.parent.revision !== child.parent.revision || source.parent.definitionDigest !== child.parent.definitionDigest ||
    !personalWorkerMailboxScopeMatches(source.harness, source, { botId, workspaceId }) ||
    !personalWorkerMailboxScopeMatches(child.harness, child, { botId, workspaceId })) return invalid()
  const frozen = personalWorkerMailboxTools(source.harness, source)
  if (!frozen.length) return invalid()
  let allowed: Awaited<ReturnType<typeof mailboxGrantTools>>
  try { allowed = await mailboxGrantTools(client, { userId, botId, workspaceId, executionId: source.parent.executionId, worker: source }, true) }
  catch (error) { if (error instanceof MailboxError) return invalid(); throw error }
  if (frozen.length !== allowed.length || frozen.some(tool => !allowed.includes(tool))) return invalid()
}

/** Check owner and current namespace again at every claim/response boundary. */
export async function currentContinuationMailboxAuthorized(client: PoolClient, userId: string, botId: string | null, source: WorkerDefinitionSnapshot | null | undefined, child: WorkerDefinitionSnapshot | null | undefined, enabled: boolean): Promise<boolean> {
  if (!source?.mailbox && !child?.mailbox) return true
  const workspace = botId
    ? (await client.query<{ workspaceId: string }>('SELECT "workspaceId" FROM bots WHERE id=$1 AND "ownerId"=$2 FOR SHARE', [botId, userId])).rows[0]?.workspaceId
    : (await import('@/lib/device-link')).WORKSPACE_ID
  if (!workspace) return false
  try {
    await authorizeContinuationMailbox(client, userId, botId, workspace, source, child, enabled)
    return true
  } catch (error) {
    if (error instanceof CiContinuationUnsupported || error instanceof ActionFailureError || error instanceof MailboxError) return false
    throw error
  }
}
