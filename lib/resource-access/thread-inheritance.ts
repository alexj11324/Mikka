import 'server-only'
import type { PoolClient } from 'pg'
import { ActionFailureError } from '@/lib/action-error'

/** Called inside the existing native admission transaction, after the new run
 * was inserted. The child may expose only the intersection with its source.
 * A private exception is never skipped when folding an ordinary continuation. */
export async function inheritThreadAccess(query: Pick<PoolClient, 'query'>, input: {
  sourceRunId: string; newRunId: string; ownerId: string; workspaceId: string;
}): Promise<void> {
  const { rows: [source] } = await query.query<{ parentId: string }>(`SELECT CASE
      WHEN p.visibility='shared' AND p."parentKind"='thread'
        AND NOT EXISTS (SELECT 1 FROM thread_execution_grants g WHERE g."threadId"=p.id
          AND g."revokedAt" IS NULL AND g."expiresAt">clock_timestamp())
      THEN p."parentId" ELSE p.id END AS "parentId"
    FROM resource_access_policies p JOIN agent_runs original ON original.id=p.id
    JOIN agent_runs child ON child.id=$2 AND child."userId"=original."userId"
      AND child."workspaceId"=original."workspaceId" AND child."issueId"=original."issueId"
    WHERE p.kind='thread' AND p.id=$1 AND p."ownerId"=$3 AND p."workspaceId"=$4
      AND original."userId"=$3 AND original."workspaceId"=$4 AND child.id<>original.id
      AND mikka_resource_acl_allowed('account',coalesce(child."agentDefinition"->'executionIdentity'->>'actor',$3),$4,'thread',p.id,'canSteer')
    FOR SHARE OF p`, [input.sourceRunId, input.newRunId, input.ownerId, input.workspaceId])
  if (!source) throw new ActionFailureError('runNotFound')
  // Insertion already owns this new policy row. Parent intersection, not a
  // copied grant list, keeps later revocation authoritative for every attempt.
  await query.query("SELECT set_config('mikka.acl_source','thread_continuation',true)")
  const changed = await query.query(`UPDATE resource_access_policies SET visibility='shared',
      "parentKind"='thread',"parentId"=$4::uuid
    WHERE kind='thread' AND id=$1::uuid AND "ownerId"=$2 AND "workspaceId"=$3::uuid
      AND EXISTS(SELECT 1 FROM resource_access_policies parent WHERE parent.kind='thread' AND parent.id=$4::uuid
        AND parent."workspaceId"=$3::uuid AND parent."ownerId"=$2)
    RETURNING id`, [input.newRunId, input.ownerId, input.workspaceId, source.parentId])
  if (!changed.rowCount) throw new ActionFailureError('runNotFound')
}
