import 'server-only'
import type { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { observeCommitEffects } from '../db/commit-effects'
import { notifyDeviceWork } from '../device-gateway-notify'
import { factoryEventId } from '../factory/event-id'
import { lockFactoryCompletionTasks } from '../run-completion-effects'
import { readRunChain } from '../run-chain'
import { sendOwnedRunMessageInTransaction } from '../run-control'
import { acquireWorkspaceMembership } from '../workspace-membership-guard'
import { MailboxError } from '../mailbox-error'
import type { MailboxTransactionLease } from '../mailbox-transaction-guard'
import { resolveRunWorktree, type WorkspaceActor } from './identity'
import { fileMentionMessage, type resolveFileMentions } from './mentions'
import { assertWorkspaceResultMaskPolicy } from './requests'

/** Supplement the exact observed Run. A stale selection never follows a chain
 * successor or advances a Factory request epoch. Those are separate actions. */
export async function submitFileMentions(database: Pool, membership: Pool,
  actor: WorkspaceActor & { sessionId: string }, input: { runId: string; repoId: string; text: string; requestId: string },
  resolved: Awaited<ReturnType<typeof resolveFileMentions>>, signal?: AbortSignal) {
  const message = fileMentionMessage(input.text, resolved)
  if (resolved.identity.runId !== input.runId || resolved.identity.repoId !== input.repoId ||
    resolved.identity.ownerId !== actor.userId || resolved.identity.workspaceId !== actor.workspaceId)
    throw new CodingWorkspaceError('workspace_not_found')
  const messageId = factoryEventId('coding-workspace-message', `${actor.userId}:${input.requestId}`)
  const client = await database.connect()
  let lease: MailboxTransactionLease | undefined, deviceId: string | null = null
  observeCommitEffects(client)
  try {
    await client.query('BEGIN')
    await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'")
    signal?.throwIfAborted()
    const factoryBound = await lockFactoryCompletionTasks(client, actor.userId, input.runId)
    const { rows: [scope] } = await client.query<{ issueId: string | null }>(
      'SELECT "issueId" FROM agent_runs WHERE id=$1 AND "userId"=$2', [input.runId, actor.userId])
    if (!scope) throw new CodingWorkspaceError('workspace_not_found')
    let issueScope: string | undefined
    if (scope.issueId) {
      const issue = await client.query<{ scope: string }>('SELECT scope FROM issues WHERE id=$1 FOR UPDATE', [scope.issueId])
      if (!issue.rowCount) throw new CodingWorkspaceError('workspace_not_found')
      issueScope = issue.rows[0]!.scope
    }
    const run = await client.query<{ issueId: string | null }>(
      'SELECT "issueId" FROM agent_runs WHERE id=$1 AND "userId"=$2 FOR UPDATE', [input.runId, actor.userId])
    if (!run.rowCount || run.rows[0]!.issueId !== scope.issueId) throw new CodingWorkspaceError('workspace_version_conflict')
    // Hold the machine authority rows against revocation/rebinding until the
    // owner message commits, then resolve all their current values again.
    await client.query(`SELECT d.id,p.id,t.id FROM agent_runs r
      JOIN devices d ON d.id=r."deviceId" JOIN device_repos p ON p.id=r."deviceRepoId"
      JOIN device_tokens t ON t.id=r."deviceTokenId" WHERE r.id=$1 FOR SHARE OF d,p,t`, [input.runId])
    await client.query('SELECT "runId" FROM thread_machines WHERE "runId"=$1 FOR SHARE', [input.runId])
    if (!(await client.query('SELECT id FROM "session" WHERE id=$1 AND "userId"=$2 AND "expiresAt">clock_timestamp() FOR SHARE',
      [actor.sessionId, actor.userId])).rowCount) throw new CodingWorkspaceError('workspace_not_found')
    lease = await acquireWorkspaceMembership(membership, actor, signal)
    if (scope.issueId && issueScope === 'workspace') {
      const link = await lease.workspaceClient!.query('SELECT "workspaceId" FROM mikka_team_issues WHERE "issueId"=$1 FOR SHARE', [scope.issueId])
      if (link.rows[0]?.workspaceId !== actor.workspaceId) throw new CodingWorkspaceError('workspace_not_found')
    }
    const binding = await resolveRunWorktree(client, lease.workspaceClient!, actor, input.runId, input.repoId)
    if (binding.identity.bindingId !== resolved.identity.bindingId) throw new CodingWorkspaceError('workspace_version_conflict')
    if (factoryBound && !(await client.query(`SELECT 1 FROM factory_tasks t JOIN factory_attempts a
      ON a.id=t."attemptId" AND a."taskId"=t.id AND a.stage=t.stage
      WHERE a."runId"=$1 AND t."userId"=$2 AND t.status='running' AND a.status='running'`,
    [input.runId, actor.userId])).rowCount) throw new CodingWorkspaceError('workspace_version_conflict')
    if ((await readRunChain(client, actor.userId, input.runId))?.latestRunId !== input.runId)
      throw new CodingWorkspaceError('workspace_version_conflict')
    deviceId = await sendOwnedRunMessageInTransaction(drizzle(client), actor.userId, { runId: input.runId, text: message, messageId })
    await lease.check()
    signal?.throwIfAborted()
    await assertWorkspaceResultMaskPolicy(resolved, actor)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    if (error instanceof MailboxError) throw new CodingWorkspaceError('workspace_not_found', { cause: error })
    throw error
  } finally { await lease?.close(); client.release() }
  notifyDeviceWork(deviceId)
  return { runId: input.runId, continued: false as const, messageId }
}
