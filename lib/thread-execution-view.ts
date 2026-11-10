import 'server-only'
import { pool } from '@/lib/db'
import { authorizedThreadCapabilities } from '@/lib/resource-access/thread'
import type { IssueReader } from '@/lib/issue-visibility'
import { resourceAccessView } from '@/lib/resource-access/view'
import { usableApiKeys } from '@/lib/model-api-keys'
import { apiKeyHarnesses } from '@/lib/model-api-key-providers'

export async function threadExecutionView(reader:IssueReader,threadId:string) {
  const access=await authorizedThreadCapabilities(reader,threadId)
  const canManage=access.viewerId===access.ownerId&&access.capabilities.canManageAccess
  const {rows:grants}=await pool.query<{id:string;threadId:string;actorId:string;credentialId:string;credentialOwnerId:string;model:string;
    harness:'claude_code'|'codex';totalComputeSeconds:number;maxTurnSeconds:number;reservedComputeSeconds:number;expiresAt:Date;revokedAt:Date|null;revision:number;
    current:boolean}>(`SELECT g.id,g."threadId",g."actorId",g."credentialId",g."credentialOwnerId",g.model,g.harness,
      g."totalComputeSeconds",g."maxTurnSeconds",g."reservedComputeSeconds",g."expiresAt",g."revokedAt",g.revision,
      g."revokedAt" IS NULL AND g."expiresAt">clock_timestamp() AND p.revision=g."policyRevision" AS current
    FROM thread_execution_grants g JOIN resource_access_policies p ON p.kind='thread' AND p.id=g."threadId"
    WHERE g."ownerId"=$2 AND g."workspaceId"=$3 AND ($4 OR g."actorId"=$5)
      AND mikka_thread_execution_source_allowed(g."threadId",$1,g."workspaceId",g."ownerId")
    ORDER BY g."createdAt" DESC,g.id LIMIT 200`,[threadId,access.ownerId,access.workspaceId,canManage,access.viewerId])
  const metadata=canManage?await resourceAccessView(reader,access.reference):null
  const keys=canManage?await usableApiKeys(pool,access.ownerId,access.workspaceId):[]
  return {workspaceId:access.workspaceId,ownerId:access.ownerId,canManage,canContinue:access.capabilities.canSteer&&access.capabilities.canComment,
    members:metadata?.members.filter(member=>member.id!==access.ownerId)??[],
    connections:keys.filter(key=>key.ownerId===access.ownerId||'ownership'in key&&key.ownership==='organization')
      .map(key=>({id:key.id,name:key.name,provider:key.provider,models:key.models,harnesses:apiKeyHarnesses(key),ownerId:key.ownerId})),
    grants:grants.map(grant=>({...grant,expiresAt:grant.expiresAt.toISOString(),revokedAt:grant.revokedAt?.toISOString()??null,
      remainingComputeSeconds:Math.max(0,grant.totalComputeSeconds-grant.reservedComputeSeconds),externalCost:null})),
  }
}
export type ThreadExecutionView=Awaited<ReturnType<typeof threadExecutionView>>
