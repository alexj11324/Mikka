import 'server-only'
import type { PoolClient } from 'pg'
import { z } from 'zod'

/** Enterprise authenticates the delegated execution owner with this durable
 * receipt. It never substitutes the owner's identity for the human actor's
 * session. Resource/device/model admission remains the run validator's job. */
export async function collaborationExecutionProof(query: Pick<PoolClient, 'query'>, input: {
  ownerId: string; workspaceId: string; authorizationId: string; actorId?: string; runId?: string;
}): Promise<{ actorId: string; sessionId: string } | null> {
  if (!z.uuid().safeParse(input.authorizationId).success || !z.uuid().safeParse(input.workspaceId).success
    || (input.runId !== undefined && !z.uuid().safeParse(input.runId).success)) return null
  const { rows: [proof] } = await query.query<{ actorId: string; sessionId: string }>(`SELECT a."actorId",a."sessionId"
    FROM thread_execution_authorizations a
    JOIN thread_execution_grants g ON g.id=a."grantId" AND g.revision=a."grantRevision"
      AND g."ownerId"=a."ownerId" AND g."actorId"=a."actorId" AND g."workspaceId"=a."workspaceId"
    JOIN resource_access_policies p ON p.kind='thread' AND p.id=g."threadId"
      AND p."workspaceId"=g."workspaceId" AND p."ownerId"=g."ownerId" AND p.revision=g."policyRevision"
    JOIN agent_runs source ON source.id=a."sourceRunId" AND source."userId"=a."ownerId"
      AND source."workspaceId"=a."workspaceId"
    JOIN session human ON human.id=a."sessionId" AND human."userId"=a."actorId" AND human."expiresAt">clock_timestamp()
    WHERE a.id=$1 AND a."ownerId"=$2 AND a."workspaceId"=$3 AND a."actorId"<>a."ownerId"
      AND ($4::text IS NULL OR a."actorId"=$4) AND ($5::uuid IS NULL OR a."runId"=$5)
      AND a."releasedAt" IS NULL AND a."expiresAt">clock_timestamp()
      AND g."revokedAt" IS NULL AND g."expiresAt">clock_timestamp()
      AND a."reservedSeconds"<=g."reservedComputeSeconds"
      AND mikka_thread_execution_source_allowed(g."threadId",source.id,a."workspaceId",a."ownerId")
      AND mikka_resource_acl_allowed('account',a."actorId",a."workspaceId",'thread',source.id,'canSteer')
      AND mikka_resource_acl_allowed('account',a."ownerId",a."workspaceId",'thread',g."threadId",'canManageAccess')`,
  [input.authorizationId, input.ownerId, input.workspaceId, input.actorId ?? null, input.runId ?? null])
  return proof ?? null
}
