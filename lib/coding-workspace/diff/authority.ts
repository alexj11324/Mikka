import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { CodingWorkspaceError, type RunWorktreeIdentity } from '@mikka/protocol/coding-workspace'
import { runRepositoryIdentity, type RunRepositoryIdentity } from '@mikka/protocol/coding-workspace-review'
import { issueForUser } from '../../issue-access'
import { tokenWorkspace } from '../../tokens/principal'
import { withWorkspaceAuthority, type WorkspaceAuthorizedActor } from '../authority'
import { resolveRunWorktree, type WorkspaceActor, type WorkspaceQuery } from '../identity'
import { diffDigest } from './patch'

export type ReviewActor = WorkspaceAuthorizedActor
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

/** Review-specific state is built inside the shared final-authority lease. */
export async function withReviewTransaction<T>(database: Pool, membership: Pool, actor: ReviewActor,
  runId: string, repoId: string, work: (client: PoolClient, scope: ReviewScope) => Promise<T>,
  options: { live?: RunWorktreeIdentity; signal?: AbortSignal } = {}): Promise<T> {
  return withWorkspaceAuthority(database, membership, actor, runId, async (client, workspace) => {
    if (options.live) await retainBinding(client, workspace, actor, options.live)
    const scope = await resolveReviewScope(client, workspace, actor, runId, repoId)
    await client.query(`INSERT INTO coding_workspace_review_boards (id,"workspaceId","taskId","runId","repositoryKey")
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
    [scope.boardId, actor.workspaceId, scope.taskId, scope.taskId ? null : runId, scope.identity.repositoryKey])
    return work(client, scope)
  }, options)
}
