import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { CodingWorkspaceError, type RunWorktreeIdentity } from '@mikka/protocol/coding-workspace'
import { runRepositoryIdentity, type RunRepositoryIdentity } from '@mikka/protocol/coding-workspace-review'
import { issueForUser } from '../../issue-access'
import { tokenWorkspace } from '../../tokens/principal'
import { observeCommitEffects } from '../../db/commit-effects'
import { resolveRunWorktree, type WorkspaceActor, type WorkspaceQuery } from '../identity'
import { diffDigest } from './patch'

export type ReviewActor = WorkspaceActor & { credential:
  | { kind: 'session'; id: string }
  | { kind: 'pat'; id: string }
  | { kind: 'device'; id: string; deviceId: string } }
export type ReviewScope = { identity: RunRepositoryIdentity; taskId: string | null; boardId: string; status: string; stopped: boolean }
const denied = () => new CodingWorkspaceError('workspace_not_found')

export function reviewBoardId(identity: RunRepositoryIdentity, taskId: string | null) {
  return diffDigest(JSON.stringify([identity.workspaceId, taskId ? 'task' : 'run', taskId ?? identity.runId, identity.repositoryKey]))
}

/** Historical access grants only retained artifacts. It never establishes
 * device access, and never changes the existing private thread-detail ACL. */
export async function resolveReviewScope(database: WorkspaceQuery, membership: WorkspaceQuery, actor: WorkspaceActor,
  runId: string, repoId: string): Promise<ReviewScope> {
  const { rows: [row] } = await database.query<{
    runId: string; repoId: string; ownerId: string; workspaceId: string; repositoryKey: string;
    userId: string; issueId: string | null; status: string; stopped: boolean;
    frozenWorkspace: string | null; admissionWorkspace: string | null; frozenKey: string | null; publicationKey: string | null;
  }>(`SELECT b.*,r."userId",r."issueId",r.status,r."stopRequestedAt" IS NOT NULL AS stopped,
    r."agentDefinition"#>>'{executionIdentity,workspaceId}' AS "frozenWorkspace",
    r."agentDefinition"#>>'{repositoryAdmission,workspaceId}' AS "admissionWorkspace",
    r."agentDefinition"#>>'{repositoryAdmission,remoteKey}' AS "frozenKey",p."remoteKey" AS "publicationKey"
    FROM coding_workspace_bindings b JOIN agent_runs r ON r.id=b."runId" AND r."userId"=b."ownerId"
    LEFT JOIN run_publications p ON p."runId"=r.id AND p."userId"=r."userId"
    WHERE b."runId"=$1 AND b."repoId"=$2 AND b."workspaceId"=$3`, [runId, repoId, actor.workspaceId])
  if (!row || [row.frozenWorkspace, row.admissionWorkspace].some(value => value && value !== row.workspaceId)
    || [row.frozenKey, row.publicationKey].some(value => value && value !== row.repositoryKey)) throw denied()
  const member = await membership.query(`SELECT 1 FROM mikka_workspaces w JOIN mikka_workspace_members m ON m."workspaceId"=w.id
    WHERE w.id=$1 AND m."userId"=$2 AND m.status='active'`, [actor.workspaceId, actor.userId])
  if (!member.rowCount) throw denied()
  if (row.issueId) {
    if (!await issueForUser({ id: actor.userId, [tokenWorkspace]: actor.workspaceId }, row.issueId, false,
      drizzle(database as Pool), { withoutBody: true })) throw denied()
  } else if (row.ownerId !== actor.userId) throw denied()
  const identity = runRepositoryIdentity.parse({ version: 1, runId, repoId, ownerId: row.ownerId,
    workspaceId: row.workspaceId, repositoryKey: row.repositoryKey })
  return { identity, taskId: row.issueId, boardId: reviewBoardId(identity, row.issueId), status: row.status, stopped: row.stopped }
}

/** Only a fresh live resolution may introduce an immutable historical binding.
 * A same-name repository found later cannot repair missing legacy evidence. */
async function retainBinding(database: WorkspaceQuery, membership: WorkspaceQuery, actor: WorkspaceActor, expected: RunWorktreeIdentity) {
  const current = await resolveRunWorktree(database, membership, actor, expected.runId, expected.repoId)
  if (current.identity.bindingId !== expected.bindingId) throw new CodingWorkspaceError('workspace_version_conflict')
  const value = current.identity
  await database.query(`INSERT INTO coding_workspace_bindings ("runId","repoId","ownerId","workspaceId","repositoryKey")
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT ("runId","repoId") DO NOTHING`,
  [value.runId, value.repoId, value.ownerId, value.workspaceId, value.repositoryKey])
  const { rows: [saved] } = await database.query<{ ownerId: string; workspaceId: string; repositoryKey: string }>(
    'SELECT "ownerId","workspaceId","repositoryKey" FROM coding_workspace_bindings WHERE "runId"=$1 AND "repoId"=$2', [value.runId, value.repoId])
  if (!saved || saved.ownerId !== value.ownerId || saved.workspaceId !== value.workspaceId || saved.repositoryKey !== value.repositoryKey)
    throw new CodingWorkspaceError('workspace_version_conflict')
}

async function lockCredential(client: PoolClient, actor: ReviewActor, runId: string) {
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
export async function withReviewTransaction<T>(database: Pool, membership: Pool, actor: ReviewActor,
  runId: string, repoId: string, work: (client: PoolClient, scope: ReviewScope) => Promise<T>,
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
      await retainBinding(client, workspace, actor, options.live)
    }
    const scope = await resolveReviewScope(client, workspace, actor, runId, repoId)
    if (scope.taskId !== initial.issueId) throw new CodingWorkspaceError('workspace_version_conflict')
    await client.query(`INSERT INTO coding_workspace_review_boards (id,"workspaceId","taskId","runId","repositoryKey")
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
    [scope.boardId, actor.workspaceId, scope.taskId, scope.taskId ? null : runId, scope.identity.repositoryKey])
    const result = await work(client, scope)
    await lockCredential(client, actor, runId)
    if (options.live && (await resolveRunWorktree(client, workspace, actor, runId, repoId)).identity.bindingId !== options.live.bindingId)
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
