import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { CodingWorkspaceError, type RunWorktreeIdentity } from '@mikka/protocol/coding-workspace'
import { runRepositoryIdentity, type RunRepositoryIdentity } from '@mikka/protocol/coding-workspace-review'
import { repositoryBindingMatches } from '@mikka/protocol/repository'
import { issueForUser } from '../../issue-access'
import { tokenWorkspace } from '../../tokens/principal'
import { withWorkspaceAuthority, type WorkspaceAuthorizedActor, type WorkspaceAuthorityLease, type WorkspaceAuthorityOptions } from '../authority'
import { resolveRunWorktree, type WorkspaceActor, type WorkspaceQuery } from '../identity'
import { reviewBoardId } from './board-id'

export { reviewBoardId } from './board-id'

export type ReviewActor = WorkspaceAuthorizedActor
export type ReviewScope = { identity: RunRepositoryIdentity; taskId: string | null; boardId: string; status: string; stopped: boolean }
const denied = () => new CodingWorkspaceError('workspace_not_found')

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

/** A stopped Run can be reviewed for the first time without an active daemon
 * token. Its original tenant and repository must still be provable from host
 * records; neither a current Task link nor a caller-selected repo can supply
 * missing provenance. A physically deleted, never-recorded repo stays absent. */
async function retainHistoricalBinding(client: PoolClient, actor: ReviewActor, runId: string, expectedRepoId: string) {
  const { rows: [row] } = await client.query<{
    ownerId: string; repoId: string; repositoryKey: string; remoteUrl: string | null;
    frozenWorkspace: string | null; admissionWorkspace: string | null; frozenKey: string | null; publicationKey: string | null;
  }>(`SELECT r."userId" AS "ownerId",p.id AS "repoId",p."repoPath" AS "repositoryKey",p."remoteUrl",
    r."agentDefinition"#>>'{executionIdentity,workspaceId}' AS "frozenWorkspace",
    r."agentDefinition"#>>'{repositoryAdmission,workspaceId}' AS "admissionWorkspace",
    r."agentDefinition"#>>'{repositoryAdmission,remoteKey}' AS "frozenKey",publication."remoteKey" AS "publicationKey"
    FROM agent_runs r JOIN device_repos p ON p.id=r."deviceRepoId" AND p."userId"=r."userId" AND p."deviceId"=r."deviceId"
    JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=r."userId"
    LEFT JOIN run_publications publication ON publication."runId"=r.id AND publication."userId"=r."userId" AND publication."issueId"=r."issueId"
    WHERE r.id=$1 FOR SHARE OF p,d`, [runId])
  const workspaceId = row?.frozenWorkspace ?? row?.admissionWorkspace
  if (!row || row.repoId !== expectedRepoId || !workspaceId || workspaceId !== actor.workspaceId
    || [row.frozenWorkspace, row.admissionWorkspace].some(value => value && value !== workspaceId)
    || !(row.frozenKey ?? row.publicationKey)
    || [row.frozenKey, row.publicationKey].some(value => value && value !== row.repositoryKey)
    || !repositoryBindingMatches(row.repositoryKey, row.remoteUrl, { allowFile: true })) throw denied()
  await client.query(`INSERT INTO coding_workspace_bindings ("runId","repoId","ownerId","workspaceId","repositoryKey")
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT ("runId","repoId") DO NOTHING`,
  [runId, row.repoId, row.ownerId, workspaceId, row.repositoryKey])
}

/** Review-specific state is built inside the shared final-authority lease. */
export async function withReviewTransaction<T>(database: Pool, membership: Pool, actor: ReviewActor,
  runId: string, repoId: string, work: (client: PoolClient, scope: ReviewScope, lease: WorkspaceAuthorityLease) => Promise<T>,
  options: WorkspaceAuthorityOptions & { historical?: boolean } = {}): Promise<T> {
  return withWorkspaceAuthority(database, membership, actor, runId, async (client, workspace, lease) => {
    if (options.live) await retainBinding(client, workspace, actor, options.live)
    else if (options.historical) await retainHistoricalBinding(client, actor, runId, repoId)
    const scope = await resolveReviewScope(client, workspace, actor, runId, repoId)
    await client.query(`INSERT INTO coding_workspace_review_boards (id,"workspaceId","taskId","runId","repositoryKey")
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
    [scope.boardId, actor.workspaceId, scope.taskId, scope.taskId ? null : runId, scope.identity.repositoryKey])
    return work(client, scope, lease)
  }, options)
}
