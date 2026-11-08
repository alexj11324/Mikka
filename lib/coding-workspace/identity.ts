import 'server-only'
import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { CodingWorkspaceError, runWorktreeIdentity, type RunWorktreeIdentity } from '@mikka/protocol/coding-workspace'
import { repositoryBindingMatches } from '@mikka/protocol/repository'
import { drizzle } from 'drizzle-orm/node-postgres'
import { issueForUser } from '../issue-access'
import { tokenWorkspace } from '../tokens/principal'

export type WorkspaceQuery = Pick<Pool | PoolClient, 'query'>
export type WorkspaceActor = { userId: string; workspaceId: string }

/** The task VM can have a different repository row from its Bot runtime.
 * Discover it through the same authorization, never from a client guess. */
export async function discoverRunWorktree(database: WorkspaceQuery, membership: WorkspaceQuery, actor: WorkspaceActor, runId: string) {
  const { rows: [run] } = await database.query<{ deviceRepoId: string | null }>(
    'SELECT "deviceRepoId" FROM agent_runs WHERE id=$1 AND "userId"=$2', [runId, actor.userId])
  if (!run?.deviceRepoId) throw new CodingWorkspaceError('workspace_not_found')
  return resolveRunWorktree(database, membership, actor, runId, run.deviceRepoId)
}

type RunBinding = {
  id: string; userId: string; issueId: string | null; deviceId: string; deviceRepoId: string; deviceTokenId: string;
  worktreePath: string | null; remoteKey: string; remoteUrl: string | null;
  frozenKey: string | null; frozenWorkspace: string | null; admissionWorkspace: string | null; publicationKey: string | null;
  tokenWorkspace: string | null; machineWorkspace: string | null; machineState: string | null;
  kind: string; sandboxId: string | null; epoch: string | null; operationId: string | null;
  stopped: boolean; leaseValid: boolean; active: boolean;
}

/** Live machine access is deliberately narrower than reading a shared task.
 * A member cannot turn visibility of another person's thread into filesystem
 * access on that person's private device or subscription VM. */
export async function resolveRunWorktree(database: WorkspaceQuery, membership: WorkspaceQuery,
  actor: WorkspaceActor, runId: string, repoId: string): Promise<{ identity: RunWorktreeIdentity; tokenId: string }> {
  const { rows: [row] } = await database.query<RunBinding>(`SELECT r.id,r."userId",r."issueId",r."deviceId",r."deviceRepoId",r."deviceTokenId",r."worktreePath",
    p."repoPath" AS "remoteKey",p."remoteUrl",r."agentDefinition"#>>'{repositoryAdmission,remoteKey}' AS "frozenKey",
    r."agentDefinition"#>>'{executionIdentity,workspaceId}' AS "frozenWorkspace",pub."remoteKey" AS "publicationKey",
    r."agentDefinition"#>>'{repositoryAdmission,workspaceId}' AS "admissionWorkspace",
    t."boundWorkspaceId" AS "tokenWorkspace",m."workspaceId" AS "machineWorkspace",m.state AS "machineState",d.kind,
    m."sandboxId",m.epoch::text,m."operationId",r."stopRequestedAt" IS NOT NULL AS stopped,
    r."leaseExpiresAt">clock_timestamp() AS "leaseValid",r.status IN ('preparing','running','waiting_input','finishing') AS active
    FROM agent_runs r JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=r."userId" AND d."removedAt" IS NULL AND d.enabled
    JOIN device_repos p ON p.id=r."deviceRepoId" AND p."deviceId"=d.id AND p."userId"=r."userId"
    JOIN device_tokens t ON t.id=r."deviceTokenId" AND t."userId"=r."userId" AND t."revokedAt" IS NULL
      AND (t."expiresAt" IS NULL OR t."expiresAt">clock_timestamp()) AND (t."boundDeviceId" IS NULL OR t."boundDeviceId"=d.id)
    LEFT JOIN thread_machines m ON m."runId"=r.id AND m."ownerId"=r."userId" AND m."deviceId"=r."deviceId"
    LEFT JOIN run_publications pub ON pub."runId"=r.id AND pub."userId"=r."userId"
    WHERE r.id=$1 AND r."userId"=$2 AND p.id=$3`, [runId, actor.userId, repoId])
  if (!row) throw new CodingWorkspaceError('workspace_not_found')
  // Current task links can move between workspaces. They cannot establish the
  // original tenant of an older checkout with no frozen execution evidence.
  const workspaceId = row.frozenWorkspace ?? row.machineWorkspace ?? row.tokenWorkspace ?? row.admissionWorkspace
  if (!workspaceId || workspaceId !== actor.workspaceId ||
    [row.frozenWorkspace, row.tokenWorkspace, row.machineWorkspace, row.admissionWorkspace].some(value => value && value !== workspaceId)) throw new CodingWorkspaceError('workspace_not_found')
  // Re-read current membership even when a previous ticket/session was valid.
  const member = await membership.query(`SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 AND status='active'`, [workspaceId, actor.userId])
  if (!member.rowCount || !repositoryBindingMatches(row.remoteKey, row.remoteUrl, { allowFile: true }) ||
    [row.frozenKey, row.publicationKey].some(key => key && key !== row.remoteKey)) throw new CodingWorkspaceError('workspace_not_found')
  // Frozen machine authority does not replace current task visibility. Keep
  // the existing task ACL, including deletion and shared-workspace membership.
  if (row.issueId && !await issueForUser({ id: actor.userId, [tokenWorkspace]: workspaceId }, row.issueId, false,
    drizzle(database as Pool), { withoutBody: true })) throw new CodingWorkspaceError('workspace_not_found')
  if (row.stopped || (row.active && !row.leaseValid) || (row.kind === 'cloud' && (row.machineState !== 'running' || !row.sandboxId)))
    throw new CodingWorkspaceError('workspace_machine_unavailable')
  if (!row.worktreePath) throw new CodingWorkspaceError('workspace_checkout_unavailable')
  const bindingId = createHash('sha256').update(JSON.stringify([row.id, workspaceId, row.userId, row.deviceId, row.deviceRepoId,
    row.deviceTokenId, row.remoteKey, row.worktreePath, row.sandboxId, row.epoch, row.operationId])).digest('hex')
  return { identity: runWorktreeIdentity.parse({ version: 1, runId, repoId, workspaceId, ownerId: actor.userId,
    deviceId: row.deviceId, repositoryKey: row.remoteKey, bindingId }), tokenId: row.deviceTokenId }
}
