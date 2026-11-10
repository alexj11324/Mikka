import 'server-only'
import { createHash,randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { and,eq,inArray,or,sql } from 'drizzle-orm'
import { z } from 'zod'
import { db,pool } from '@/lib/db'
import { ActionFailureError } from '@/lib/action-error'
import type { IssueReader } from '@/lib/issue-visibility'
import { taskReaderScope } from '@/lib/task-workspace'
import { authorizedThread } from '@/lib/resource-access/thread'
import { withResourceAccess } from '@/lib/resource-access/store'
import { armDueTimerAfterCommit } from '@/lib/due-timer'
import { workspaceDb } from '@/lib/workspace-db'
import { workspaceMembers,workspaces } from '@/lib/db/workspace-schema'
import { enterpriseWorkspaceAllowed } from '@/lib/enterprise/access'
import { threadExecutionGrantInput } from '@/lib/resource-access/input'
import { apiKeyHarnesses } from '@/lib/model-api-key-providers'
export { threadExecutionGrantInput } from '@/lib/resource-access/input'

type Query = Pick<PoolClient, 'query'>
export type CollaborationRunAuthorityInput = {
  authorizationId: string; actorId: string; executionOwnerId: string; threadOwnerId: string;
  workspaceId: string; deviceId: string; credentialKind: 'api_key' | 'subscription' | 'native_login';
  credentialOwnerId: string; credentialId: string; model: string; harness: string;
}

/** The receipt, live ACL and live human session are authoritative. Frozen
 * snapshot fields are references, never a bearer grant. Native personal
 * subscriptions/login and personal devices cannot be delegated by this API. */
export async function validateCollaborationRunAuthority(query: Query, input: CollaborationRunAuthorityInput): Promise<boolean> {
  if (!z.uuid().safeParse(input.authorizationId).success || input.actorId === input.executionOwnerId
    || input.executionOwnerId !== input.threadOwnerId || input.credentialKind !== 'api_key') return false
  const { rows: [receipt] } = await query.query<{ sessionId: string }>(`SELECT a."sessionId"
    FROM thread_execution_authorizations a
    JOIN thread_execution_grants g ON g.id=a."grantId" AND g.revision=a."grantRevision"
    JOIN resource_access_policies p ON p.kind='thread' AND p.id=g."threadId"
      AND p."workspaceId"=g."workspaceId" AND p."ownerId"=g."ownerId" AND p.revision=g."policyRevision"
    JOIN agent_runs source ON source.id=a."sourceRunId" AND source."userId"=g."ownerId"
      AND source."workspaceId"=g."workspaceId"
    JOIN devices device ON device.id=$6 AND device."ownerId"=g."computeOwnerId"
      AND device.kind='cloud' AND device.enabled AND device."removedAt" IS NULL
    JOIN "session" human ON human.id=a."sessionId" AND human."userId"=a."actorId" AND human."expiresAt">clock_timestamp()
    WHERE a.id=$1 AND a."actorId"=$2 AND a."ownerId"=$3 AND a."workspaceId"=$4
      AND g."ownerId"=$5 AND g."credentialOwnerId"=$7 AND g."credentialId"=$8
      AND g.model=$9 AND g.harness=$10 AND g."computeOwnerId"=$3
      AND g."revokedAt" IS NULL AND g."expiresAt">clock_timestamp()
      AND a."releasedAt" IS NULL AND a."expiresAt">clock_timestamp()
      AND a."reservedSeconds"<=g."reservedComputeSeconds"
      AND EXISTS(SELECT 1 FROM run_resource_disclosures disclosure WHERE disclosure."runId"=source.id
        AND disclosure.attempt=greatest(source.attempt,1) AND NOT disclosure."personalResources"
        AND disclosure.provenance='claim' AND disclosure."deviceId"=source."deviceId")
      AND NOT EXISTS(SELECT 1 FROM run_resource_disclosures disclosure
        WHERE (disclosure."runId"=source.id OR disclosure."deviceId" IN (source."deviceId",device.id))
          AND disclosure."personalResources")
      AND NOT EXISTS(SELECT 1 FROM agent_runs prior WHERE prior."deviceId" IN(source."deviceId",device.id)
        AND (prior."startedAt" IS NOT NULL OR prior.status<>'queued')
        AND NOT EXISTS(SELECT 1 FROM run_resource_disclosures d WHERE d."runId"=prior.id
          AND d.attempt=greatest(prior.attempt,1) AND d.provenance='claim' AND NOT d."personalResources"))
      AND source."agentDefinition"->>'contextIsolation'='shared_clean'
      AND mikka_run_model_credential_history_allowed(source.id,device.id,$2,$3,'api_key',$8,$7)
      AND mikka_thread_execution_source_allowed(g."threadId",a."sourceRunId",a."workspaceId",a."ownerId")
      AND mikka_resource_acl_allowed('account',$2,$4,'thread',g."threadId",'canSteer')
      AND mikka_resource_acl_allowed('account',$3,$4,'thread',g."threadId",'canManageAccess')
      AND EXISTS (SELECT 1 FROM thread_machines machine WHERE machine."deviceId"=device.id
        AND machine."ownerId"=$3 AND machine."workspaceId"=$4 AND machine."issueId"=source."issueId"
        AND machine.state<>'ended')`,
  [input.authorizationId, input.actorId, input.executionOwnerId, input.workspaceId, input.threadOwnerId,
    input.deviceId, input.credentialOwnerId, input.credentialId, input.model, input.harness])
  if (!receipt) return false
  const members=await workspaceDb.select({id:workspaceMembers.userId}).from(workspaceMembers)
    .innerJoin(workspaces,eq(workspaces.id,workspaceMembers.workspaceId))
    .where(and(eq(workspaces.id,input.workspaceId),eq(workspaceMembers.status,'active'),
      inArray(workspaceMembers.userId,[input.actorId,input.executionOwnerId]),or(eq(workspaces.kind,'team'),eq(workspaces.userId,workspaceMembers.userId))))
  if(new Set(members.map(member=>member.id)).size!==2)return false
  if(!await enterpriseWorkspaceAllowed(input.actorId,input.workspaceId,{kind:'session',sessionId:receipt.sessionId},workspaceDb,query))return false
  return enterpriseWorkspaceAllowed(input.executionOwnerId,input.workspaceId,
    {kind:'collaboration',authorizationId:input.authorizationId,workspaceId:input.workspaceId},workspaceDb,query)
}

export async function grantThreadExecution(reader: IssueReader, threadId: string, input: z.input<typeof threadExecutionGrantInput>) {
  const value = threadExecutionGrantInput.parse(input)
  const access = await authorizedThread(reader, threadId, 'canManageAccess')
  if (access.ownerId !== access.viewerId || value.actorId === access.ownerId
    || new Date(value.expiresAt).getTime() <= Date.now() || new Date(value.expiresAt).getTime() > Date.now() + 30 * 86_400_000)
    throw new ActionFailureError('validationGeneric')
  const [member]=await workspaceDb.select({id:workspaceMembers.userId}).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId,access.workspaceId),eq(workspaceMembers.userId,value.actorId),eq(workspaceMembers.status,'active'))).limit(1)
  if(!member)throw new ActionFailureError('workspaceAccessDenied')
  const {usableApiKeys}=await import('@/lib/model-api-keys')
  const available=await usableApiKeys(pool,access.ownerId,access.workspaceId,value.credentialId)
  const selected=available.find(key=>key.id===value.credentialId&&key.models.includes(value.model)&&apiKeyHarnesses(key).includes(value.harness))
  if(!selected||(selected.ownerId!==access.ownerId&&(!('ownership'in selected)||selected.ownership!=='organization')))
    throw new ActionFailureError('executionAccountUnavailable')
  return withResourceAccess(reader, access.reference, 'canManageAccess', async (policy, tx) => {
    const { rows: [key] } = await db.execute<{ ownerId: string }>(sql`select "ownerId" from model_api_keys where id=${value.credentialId}::uuid
      and "ownerId"=${selected.ownerId} and to_jsonb(model_api_keys)->>'revokedAt' is null`)
    if (!key) throw new ActionFailureError('executionAccountUnavailable')
    const id = randomUUID()
    await db.execute(sql`select set_config('mikka.acl_actor',${access.viewerId},true)`)
    await db.execute(sql`insert into thread_execution_grants(id,"workspaceId","threadId","ownerId","actorId","policyRevision",
      "credentialId","credentialOwnerId",model,harness,"computeOwnerId","totalComputeSeconds","maxTurnSeconds","expiresAt")
      values(${id}::uuid,${access.workspaceId}::uuid,${threadId}::uuid,${access.ownerId},${value.actorId},${policy.revision},
        ${value.credentialId}::uuid,${key.ownerId},${value.model},${value.harness},${access.ownerId},${value.totalComputeSeconds},${value.maxTurnSeconds},${value.expiresAt}::timestamptz)`)
    armDueTimerAfterCommit(tx, 'run-recovery')
    return { id, revision: 1, actorId: value.actorId, totalComputeSeconds: value.totalComputeSeconds,
      reservedComputeSeconds: 0, maxTurnSeconds: value.maxTurnSeconds, expiresAt: value.expiresAt }
  })
}

/** Reserve one bounded turn under the existing ACL write lease. An idempotent
 * request cannot consume twice or move its receipt to another actor/thread. */
export async function reserveCollaborativeTurn(reader: IssueReader, input: {
  grantId: string; threadId: string; sourceRunId: string; requestId: string; sessionId: string; text:string;
}) {
  for (const id of [input.grantId, input.threadId, input.sourceRunId, input.requestId])
    if (!z.uuid().safeParse(id).success) throw new ActionFailureError('validationGeneric')
  const access = await authorizedThread(reader, input.threadId, 'canSteer')
  if (access.viewerId === access.ownerId) throw new ActionFailureError('validationGeneric')
  const fingerprint=createHash('sha256').update(JSON.stringify([access.viewerId,input.grantId,input.threadId,input.sourceRunId,input.text])).digest('hex')
  return withResourceAccess(reader, access.reference, 'canSteer', async (_policy, tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${'enterprise-live-session:' + input.sessionId},0))`)
    const { rows: [grant] } = await db.execute<{ id: string; revision: number; threadId: string; maxTurnSeconds: number; totalComputeSeconds: number;
      reservedComputeSeconds: number; credentialId: string; credentialOwnerId: string; model: string; harness: 'claude_code' | 'codex'; expiresAt: Date }>(sql`
      select g.* from thread_execution_grants g join resource_access_policies p on p.kind='thread' and p.id=g."threadId"
        and p."workspaceId"=g."workspaceId" and p."ownerId"=g."ownerId" and p.revision=g."policyRevision"
      where g.id=${input.grantId}::uuid and g."workspaceId"=${access.workspaceId}::uuid
        and g."actorId"=${access.viewerId} and g."ownerId"=${access.ownerId}
        and mikka_thread_execution_source_allowed(g."threadId",${input.threadId}::uuid,g."workspaceId",g."ownerId")
        and g."revokedAt" is null and g."expiresAt">clock_timestamp() for update of g`)
    if (!grant) throw new ActionFailureError('threadExecutionAuthorizationRequired')
    const { rows: [existing] } = await db.execute<{ id: string; sourceRunId: string; grantId: string; requestFingerprint:string; expiresAt: Date;releasedAt:Date|null }>(sql`
      select id,"sourceRunId","grantId","requestFingerprint","expiresAt","releasedAt" from thread_execution_authorizations
      where "actorId"=${access.viewerId} and "requestId"=${input.requestId}::uuid`)
    if (existing) {
      if (existing.releasedAt||existing.grantId !== grant.id || existing.requestFingerprint!==fingerprint || existing.sourceRunId !== input.sourceRunId || existing.expiresAt <= new Date())
        throw new ActionFailureError('threadExecutionAuthorizationRequired')
      return { authorizationId: existing.id, ...grant, executionOwnerId: access.ownerId, actorId: access.viewerId }
    }
    const { rows: [source] } = await db.execute<{ id: string }>(sql`select r.id from agent_runs r
      join "session" s on s.id=${input.sessionId} and s."userId"=${access.viewerId} and s."expiresAt">clock_timestamp()
      where r.id=${input.sourceRunId}::uuid and r."userId"=${access.ownerId} and r."workspaceId"=${access.workspaceId}::uuid
        and mikka_thread_execution_source_allowed(${grant.threadId}::uuid,r.id,r."workspaceId",r."userId")
        and mikka_resource_acl_allowed('account',${access.viewerId},r."workspaceId",'thread',r.id,'canSteer')`)
    if (!source) throw new ActionFailureError('authRequired')
    const {rows:[clean]}=await tx.execute<{allowed:boolean}>(sql`select
      mikka_run_clean_execution_allowed(r.id,r."deviceId")
      and mikka_run_model_credential_history_allowed(r.id,r."deviceId",${access.viewerId},${access.ownerId},
        'api_key',${grant.credentialId},${grant.credentialOwnerId})
      and exists(select 1 from run_resource_disclosures d where d."runId"=r.id and d.attempt=greatest(r.attempt,1) and not d."personalResources" and d.provenance='claim')
      and not exists(select 1 from run_resource_disclosures d where (d."runId"=r.id or d."deviceId"=r."deviceId") and d."personalResources")
      and not exists(select 1 from agent_runs old where old."deviceId"=r."deviceId" and (old."startedAt" is not null or old.status<>'queued')
        and not exists(select 1 from run_resource_disclosures d where d."runId"=old.id and d.attempt=greatest(old.attempt,1) and not d."personalResources" and d.provenance='claim')) as allowed
      from agent_runs r where r.id=${input.sourceRunId}::uuid`)
    if(!clean?.allowed)throw new ActionFailureError('threadExecutionPrivateEnvironment')
    if (grant.reservedComputeSeconds + grant.maxTurnSeconds > grant.totalComputeSeconds)
      throw new ActionFailureError('threadExecutionBudgetExceeded')
    const authorizationId = randomUUID()
    await db.execute(sql`select set_config('mikka.acl_actor',${access.viewerId},true)`)
    await db.execute(sql`update thread_execution_grants set "reservedComputeSeconds"="reservedComputeSeconds"+${grant.maxTurnSeconds} where id=${grant.id}::uuid`)
    await db.execute(sql`insert into thread_execution_authorizations(id,"grantId","grantRevision","requestId","requestFingerprint","workspaceId","threadId",
      "sourceRunId","ownerId","actorId","sessionId","reservedSeconds","expiresAt")
      values(${authorizationId}::uuid,${grant.id}::uuid,${grant.revision},${input.requestId}::uuid,${fingerprint},${access.workspaceId}::uuid,${grant.threadId}::uuid,
        ${input.sourceRunId}::uuid,${access.ownerId},${access.viewerId},${input.sessionId},${grant.maxTurnSeconds},
        least(${grant.expiresAt}::timestamptz,clock_timestamp()+${grant.maxTurnSeconds}*interval '1 second'))`)
    armDueTimerAfterCommit(tx, 'run-recovery')
    return { authorizationId, ...grant, executionOwnerId: access.ownerId, actorId: access.viewerId }
  })
}

/** No refund is inferred from an unknown provider invoice. Only a reservation
 * that never admitted any run can be released, once, after an admission error. */
export async function releaseUnadmittedCollaborationTurn(query: Query, authorizationId: string): Promise<void> {
  await query.query(`WITH released AS (
    UPDATE thread_execution_authorizations a SET "releasedAt"=clock_timestamp()
    WHERE a.id=$1 AND a."releasedAt" IS NULL AND a."runId" IS NULL
      AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r."agentDefinition"->'executionIdentity'->>'collaborationAuthorizationId'=a.id::text)
    RETURNING a."grantId",a."reservedSeconds")
    UPDATE thread_execution_grants g SET "reservedComputeSeconds"=g."reservedComputeSeconds"-released."reservedSeconds"
    FROM released WHERE g.id=released."grantId"`, [authorizationId])
}

export async function revokeThreadExecution(reader: IssueReader, threadId: string, grantId: string) {
  if (!z.uuid().safeParse(grantId).success) throw new ActionFailureError('validationGeneric')
  const access = await authorizedThread(reader, threadId, 'canManageAccess')
  return withResourceAccess(reader, access.reference, 'canManageAccess', async (_policy, tx) => {
    await db.execute(sql`select set_config('mikka.acl_actor',${taskReaderScope(reader).userId},true)`)
    await db.execute(sql`update thread_execution_grants set "revokedAt"=coalesce("revokedAt",clock_timestamp()),revision=revision+1
      where id=${grantId}::uuid and "threadId"=${threadId}::uuid and "ownerId"=${access.viewerId} and "revokedAt" is null`)
    const { rows } = await db.execute<{ id: string }>(sql`update agent_runs r set "stopRequestedAt"=coalesce("stopRequestedAt",clock_timestamp())
      where r."workspaceId"=${access.workspaceId}::uuid and r."userId"=${access.ownerId}
        and r.status in ('queued','preparing','running','waiting_input','paused','finishing')
        and exists(select 1 from thread_execution_authorizations a where a."grantId"=${grantId}::uuid
          and a.id::text=r."agentDefinition"->'executionIdentity'->>'collaborationAuthorizationId') returning r.id`)
    const { runChanged } = await import('@/lib/live/panels')
    for (const row of rows) await runChanged(db, row.id)
    armDueTimerAfterCommit(tx, 'run-recovery')
    return { revoked: true as const, stoppedRuns: rows.length }
  })
}

/** A Factory stage or a quota continuation spends a fresh bounded reservation
 * from the same grant. It cannot recycle a prior run's single-use receipt,
 * change the actor, extend the human session, or switch the payer. */
export async function mintNextCollaborationReceipt(query: Query, input: {
  authorizationId: string; sourceRunId: string; requestId: string;
}): Promise<{ authorizationId: string; actorId: string; threadOwnerId: string }> {
  for (const id of Object.values(input)) if (!z.uuid().safeParse(id).success) throw new ActionFailureError('validationGeneric')
  const { rows: [origin] } = await query.query<{ grantId: string; grantRevision: number; sessionId: string; actorId: string; ownerId: string }>(
    `SELECT "grantId","grantRevision","sessionId","actorId","ownerId" FROM thread_execution_authorizations
     WHERE id=$1 AND "runId"=$2 AND "releasedAt" IS NULL`, [input.authorizationId, input.sourceRunId])
  if (!origin) throw new ActionFailureError('threadExecutionAuthorizationRequired')
  await query.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [`enterprise-live-session:${origin.sessionId}`])
  const { rows: [grant] } = await query.query<{ id: string; revision: number; workspaceId: string; threadId: string;
    maxTurnSeconds: number; totalComputeSeconds: number; reservedComputeSeconds: number; expiresAt: Date }>(`SELECT g.*
    FROM thread_execution_grants g JOIN resource_access_policies p ON p.kind='thread' AND p.id=g."threadId"
      AND p."workspaceId"=g."workspaceId" AND p."ownerId"=g."ownerId" AND p.revision=g."policyRevision"
    JOIN "session" s ON s.id=$2 AND s."userId"=g."actorId" AND s."expiresAt">clock_timestamp()
    WHERE g.id=$1 AND g.revision=$4 AND g."revokedAt" IS NULL AND g."expiresAt">clock_timestamp()
      AND mikka_thread_execution_source_allowed(g."threadId",$3,g."workspaceId",g."ownerId")
      AND mikka_resource_acl_allowed('account',g."actorId",g."workspaceId",'thread',$3,'canSteer')
      AND mikka_resource_acl_allowed('account',g."ownerId",g."workspaceId",'thread',g."threadId",'canManageAccess')
    FOR UPDATE OF g`, [origin.grantId, origin.sessionId, input.sourceRunId, origin.grantRevision])
  if (!grant) throw new ActionFailureError('threadExecutionAuthorizationRequired')
  const { rows: [existing] } = await query.query<{ id: string; grantId: string; sourceRunId: string; live: boolean }>(`SELECT id,"grantId","sourceRunId",
      "releasedAt" IS NULL AND "expiresAt">clock_timestamp() AS live FROM thread_execution_authorizations
    WHERE "actorId"=$1 AND "requestId"=$2`, [origin.actorId, input.requestId])
  if (existing) {
    if (!existing.live || existing.grantId !== grant.id || existing.sourceRunId !== input.sourceRunId)
      throw new ActionFailureError('threadExecutionAuthorizationRequired')
    return { authorizationId: existing.id, actorId: origin.actorId, threadOwnerId: origin.ownerId }
  }
  if (grant.reservedComputeSeconds + grant.maxTurnSeconds > grant.totalComputeSeconds)
    throw new ActionFailureError('threadExecutionBudgetExceeded')
  const id = randomUUID()
  const fingerprint=createHash('sha256').update(JSON.stringify(['continuation',origin.actorId,grant.id,input.sourceRunId,input.requestId])).digest('hex')
  await query.query("SELECT set_config('mikka.acl_actor',$1,true)", [origin.actorId])
  await query.query('UPDATE thread_execution_grants SET "reservedComputeSeconds"="reservedComputeSeconds"+$2 WHERE id=$1', [grant.id, grant.maxTurnSeconds])
  await query.query(`INSERT INTO thread_execution_authorizations(id,"grantId","grantRevision","requestId","requestFingerprint","workspaceId","threadId","sourceRunId",
    "ownerId","actorId","sessionId","reservedSeconds","expiresAt") VALUES($1,$2,$3,$4,$13,$5,$6,$7,$8,$9,$10,$11,
    least($12::timestamptz,clock_timestamp()+$11*interval '1 second'))`,
  [id, grant.id, grant.revision, input.requestId, grant.workspaceId, grant.threadId, input.sourceRunId,
    origin.ownerId, origin.actorId, origin.sessionId, grant.maxTurnSeconds, grant.expiresAt,fingerprint])
  armDueTimerAfterCommit(query, 'run-recovery')
  return { authorizationId: id, actorId: origin.actorId, threadOwnerId: origin.ownerId }
}
