import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { CodingWorkspaceError, type RunWorktreeIdentity } from '@mikka/protocol/coding-workspace'
import { observeCommitEffects } from '../db/commit-effects'
import { resolveRunWorktree, type WorkspaceActor } from './identity'

export type WorkspaceAuthorizedActor = WorkspaceActor & { credential:
  | { kind: 'session'; id: string }
  | { kind: 'pat'; id: string }
  | { kind: 'device'; id: string; deviceId: string } }
const denied = () => new CodingWorkspaceError('workspace_not_found')

async function lockCredential(client: PoolClient, actor: WorkspaceAuthorizedActor, runId: string) {
  const credential = actor.credential
  const result = credential.kind === 'session'
    ? await client.query('SELECT id FROM "session" WHERE id=$1 AND "userId"=$2 AND "expiresAt">clock_timestamp() FOR SHARE', [credential.id, actor.userId])
    : credential.kind === 'pat'
      ? await client.query(`SELECT id FROM personal_access_tokens WHERE id=$1 AND "userId"=$2 AND "workspaceId"=$3
        AND "revokedAt" IS NULL AND ("expiresAt" IS NULL OR "expiresAt">clock_timestamp()) FOR SHARE`, [credential.id, actor.userId, actor.workspaceId])
      : await client.query(`SELECT t.id FROM device_tokens t JOIN agent_runs r ON r."deviceTokenId"=t.id AND r."userId"=t."userId"
        WHERE t.id=$1 AND t."userId"=$2 AND r.id=$3 AND r."deviceId"=$4
          AND t."revokedAt" IS NULL AND (t."expiresAt" IS NULL OR t."expiresAt">clock_timestamp())
          AND (t."boundDeviceId" IS NULL OR t."boundDeviceId"=$4)
          AND (t."boundWorkspaceId" IS NULL OR t."boundWorkspaceId"=$5) FOR SHARE OF t`,
      [credential.id, actor.userId, runId, credential.deviceId, actor.workspaceId])
  if (!result.rowCount) throw denied()
}

/** Fetch remote evidence before entering this short transaction. Workspace
 * deletion locks WS before sweeping APP, so take that same order and retain
 * the workspace/member/task-link locks until the APP commit is acknowledged. */
export async function withWorkspaceAuthority<T>(database: Pool, membership: Pool, actor: WorkspaceAuthorizedActor,
  runId: string, work: (client: PoolClient, workspace: PoolClient) => Promise<T>,
  options: { live?: RunWorktreeIdentity; signal?: AbortSignal } = {}): Promise<T> {
  options.signal?.throwIfAborted()
  const { rows: [initial] } = await database.query<{ issueId: string | null }>('SELECT "issueId" FROM agent_runs WHERE id=$1', [runId])
  if (!initial) throw denied()
  const workspace = await membership.connect()
  let client: PoolClient | undefined, workspaceFailed = false, appBegan = false
  const failWorkspace = () => { workspaceFailed = true }
  workspace.on('error', failWorkspace); workspace.on('end', failWorkspace)
  const check = () => { options.signal?.throwIfAborted(); if (workspaceFailed) throw denied() }
  try {
    await workspace.query('BEGIN')
    await workspace.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='20s'")
    if (!(await workspace.query('SELECT id FROM mikka_workspaces WHERE id=$1 FOR SHARE', [actor.workspaceId])).rowCount) throw denied()
    if (!(await workspace.query(`SELECT "userId" FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 AND status='active' FOR SHARE`,
      [actor.workspaceId, actor.userId])).rowCount) throw denied()
    if (initial.issueId) {
      const link = await workspace.query<{ workspaceId: string; teamId: string }>(
        'SELECT "workspaceId","teamId" FROM mikka_team_issues WHERE "issueId"=$1 FOR SHARE', [initial.issueId])
      if (link.rows.some(value => value.workspaceId !== actor.workspaceId)) throw denied()
      for (const row of link.rows) {
        if (!(await workspace.query('SELECT id FROM mikka_teams WHERE id=$1 AND "workspaceId"=$2 FOR SHARE', [row.teamId, actor.workspaceId])).rowCount) throw denied()
      }
    }
    check()
    client = await database.connect(); observeCommitEffects(client)
    await client.query('BEGIN'); appBegan = true
    await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='20s'")
    if (initial.issueId && !(await client.query('SELECT id FROM issues WHERE id=$1 FOR SHARE', [initial.issueId])).rowCount) throw denied()
    const locked = await client.query<{ issueId: string | null }>('SELECT "issueId" FROM agent_runs WHERE id=$1 FOR SHARE', [runId])
    if (!locked.rowCount || locked.rows[0]!.issueId !== initial.issueId) throw new CodingWorkspaceError('workspace_version_conflict')
    await lockCredential(client, actor, runId)
    if ((await client.query('SELECT 1 FROM workspace_deletions WHERE id=$1', [actor.workspaceId])).rowCount) throw denied()
    if (options.live) {
      await client.query(`SELECT d.id,p.id,t.id FROM agent_runs r JOIN devices d ON d.id=r."deviceId"
        JOIN device_repos p ON p.id=r."deviceRepoId" JOIN device_tokens t ON t.id=r."deviceTokenId"
        WHERE r.id=$1 FOR SHARE OF d,p,t`, [runId])
      await client.query('SELECT "runId" FROM thread_machines WHERE "runId"=$1 FOR SHARE', [runId])
      if ((await resolveRunWorktree(client, workspace, actor, runId, options.live.repoId)).identity.bindingId !== options.live.bindingId)
        throw new CodingWorkspaceError('workspace_version_conflict')
    }
    const result = await work(client, workspace)
    await lockCredential(client, actor, runId)
    if (options.live && (await resolveRunWorktree(client, workspace, actor, runId, options.live.repoId)).identity.bindingId !== options.live.bindingId)
      throw new CodingWorkspaceError('workspace_version_conflict')
    check(); await workspace.query('SELECT 1'); check()
    await client.query('COMMIT'); appBegan = false
    return result
  } catch (error) {
    if (appBegan) await client?.query('ROLLBACK')
    throw error
  } finally {
    client?.release()
    try { if (!workspaceFailed) await workspace.query('ROLLBACK') }
    finally { workspace.removeListener('error', failWorkspace); workspace.removeListener('end', failWorkspace); workspace.release(workspaceFailed ? denied() : undefined) }
  }
}
