import 'server-only'
import type { Pool, PoolClient } from 'pg'
import { db, pool, withDatabaseTransaction } from '@/lib/db'
import { afterDatabaseCommit } from '@/lib/db/commit-effects'
import { runControlChanged } from '@/lib/device-gateway-notify'
import { armDueTimerAfterCommit, armDueTimerSoon } from '@/lib/due-timer'
import { runChanged } from '@/lib/live/panels'
import { runListChanged } from '@/lib/live/lists'
import { stopHostedExecutions } from '@/lib/hosted-execution-revocation'
import { notifyResourceAccessChanged } from '@/lib/live/resource-access'

type Query = Pick<Pool | PoolClient, 'query'>
type StoppedRun = { id: string; userId: string; status: string }
type Audience = { workspaceId: string; ownerId: string | null; subjectId?: string; subjectKind?: string }

function notifyAudiences(query: Query, audiences: readonly Audience[]) {
  const workspaces = new Map<string, Set<string>>()
  for (const row of audiences) {
    const subjects = workspaces.get(row.workspaceId) ?? new Set<string>()
    if (row.ownerId) subjects.add(row.ownerId)
    if (row.subjectId && row.subjectKind === 'account') subjects.add(row.subjectId)
    workspaces.set(row.workspaceId, subjects)
  }
  for (const [workspaceId, subjects] of workspaces) notifyResourceAccessChanged(query, workspaceId, [...subjects])
}

/** Revocation is persisted before the machine wake. Queued cloud machines use
 * the existing lifecycle to release their sandbox; an unbound queue item ends
 * here. No provider request is routed through the control plane. */
export async function stopResourceRuns(query: Query, runIds: readonly string[], reason: string) {
  if (!runIds.length) return []
  await query.query('select id from agent_runs where id=any($1::uuid[]) order by id for update', [runIds])
  const { rows } = await query.query<StoppedRun>(`WITH affected AS (
    SELECT r.id,((r.status='queued' AND NOT EXISTS(SELECT 1 FROM thread_machines m WHERE m."runId"=r.id))
      OR (r.status='paused' AND r."pauseReason"='quota_exhausted')) AS ended
    FROM agent_runs r WHERE r.id=ANY($1::uuid[]) AND r."stopRequestedAt" IS NULL
      AND r.status IN ('queued','preparing','running','paused','waiting_input','finishing')
  ) UPDATE agent_runs r SET "stopRequestedAt"=coalesce(r."stopRequestedAt",clock_timestamp()),
      "leaseExpiresAt"=CASE WHEN r.status='queued' THEN r."leaseExpiresAt" ELSE least(coalesce(r."leaseExpiresAt",clock_timestamp()),clock_timestamp()) END,
      status=CASE WHEN a.ended THEN 'stopped' ELSE r.status END,
      "pauseReason"=CASE WHEN a.ended THEN NULL ELSE r."pauseReason" END,
      "finishedAt"=CASE WHEN a.ended THEN clock_timestamp() ELSE r."finishedAt" END,"updatedAt"=clock_timestamp()
    FROM affected a WHERE r.id=a.id RETURNING r.id,r."userId",r.status`, [runIds])
  await query.query('update run_tokens set "revokedAt"=coalesce("revokedAt",clock_timestamp()) where "runId"=any($1::uuid[]) and "revokedAt" is null', [runIds])
  if (rows.length) {
    await query.query(`insert into resource_access_events("resourceKind","resourceId","workspaceId","actorId","ownerId",revision,source,action,detail)
      select p.kind,p.id,p."workspaceId",'system',p."ownerId",p.revision,'resource_lifecycle','execution_stopped',jsonb_build_object('reason',$2::text)
      from resource_access_policies p where p.kind='thread' and p.id=any($1::uuid[])`, [rows.map(row => row.id), reason])
    for (const run of rows) {
      await runListChanged(query, run.id); await runChanged(query, run.id)
      if (run.status === 'stopped') afterDatabaseCommit(query, `resource-ended:${run.id}`, async () => {
        await (await import('@/lib/run-completion-effects')).afterRunEnded(run.userId, run.id)
      })
    }
    runControlChanged(query, { runIds: rows.map(row => row.id) })
    armDueTimerAfterCommit(query, 'run-recovery')
  }
  return rows.map(row => row.id)
}

/** Called under the existing WS membership/outbox lease and an APP transaction.
 * Organization connections are not creator-owned. Only this person's grants,
 * personal private resources, actor receipts and execution resources end. */
export async function revokeMemberResourceAuthority(query: Query, workspaceId: string, userId: string) {
  const { rows: roots } = await query.query<{ kind: string; id: string }>(`select p.kind,p.id from resource_access_policies p where p."workspaceId"=$1 and (
      p."ownerId"=$2 or exists(select 1 from resource_access_grants g where g."resourceKind"=p.kind and g."resourceId"=p.id
        and g."subjectKind"='account' and g."subjectId"=$2)) order by p.kind,p.id for update`, [workspaceId, userId])
  await query.query(`select set_config('mikka.acl_source','member_departed',true)`)
  const { rows: removed } = await query.query<Audience>(`delete from resource_access_grants g using resource_access_policies p
    where p.kind=g."resourceKind" and p.id=g."resourceId" and p."workspaceId"=$1
      and ((g."subjectKind"='account' and g."subjectId"=$2) or (p."ownerId"=$2 and p.visibility='private'))
    returning p."workspaceId",p."ownerId",g."subjectKind",g."subjectId"`, [workspaceId, userId])
  const { rows: grants } = await query.query<{ id: string; ownerId: string; actorId: string }>(`select id,"ownerId","actorId" from thread_execution_grants where "workspaceId"=$1
    and ("ownerId"=$2 or "actorId"=$2 or "credentialOwnerId"=$2 or "computeOwnerId"=$2) order by id for update`, [workspaceId, userId])
  if (grants.length) {
    const ids = grants.map(row => row.id)
    await query.query('update thread_execution_grants set "revokedAt"=clock_timestamp(),revision=revision+1 where id=any($1::uuid[]) and "revokedAt" is null', [ids])
    // Admitted budgets remain consumed. Revocation is not a provider refund.
    await query.query('update thread_execution_authorizations set "releasedAt"=clock_timestamp() where "grantId"=any($1::uuid[]) and "releasedAt" is null', [ids])
  }
  const { rows: runs } = await query.query<{ id: string }>(`with recursive descendants as (
    select p.kind,p.id,0 as depth from resource_access_policies p join jsonb_to_recordset($3::jsonb) x(kind text,id uuid) on p.kind=x.kind and p.id=x.id
    union all select p.kind,p.id,d.depth+1 from descendants d join resource_access_policies p
      on p."parentKind"=d.kind and p."parentId"=d.id where d.depth<32 and p."workspaceId"=$1
  ) select r.id from agent_runs r where r."workspaceId"=$1 and (
    r."userId"=$2 or r."agentDefinition"#>>'{executionIdentity,actor}'=$2
    or r.id in(select id from descendants where kind='thread')
    or r."agentDefinition"#>>'{executionIdentity,billingAccount,model,ownerId}'=$2
    or exists(select 1 from jsonb_array_elements(CASE WHEN jsonb_typeof(r."agentDefinition"#>'{executionIdentity,resourceBindings}')='array'
      THEN r."agentDefinition"#>'{executionIdentity,resourceBindings}' ELSE '[]'::jsonb END) binding where binding->>'ownerId'=$2)
    or exists(select 1 from thread_execution_authorizations a join thread_execution_grants g on g.id=a."grantId"
      where a.id::text=r."agentDefinition"#>>'{executionIdentity,collaborationAuthorizationId}'
        and (a."actorId"=$2 or g."ownerId"=$2 or g."credentialOwnerId"=$2 or g."computeOwnerId"=$2)))`, [workspaceId, userId, JSON.stringify(roots)])
  const stopped = await stopResourceRuns(query, runs.map(row => row.id), 'member_departed')
  await stopHostedExecutions(query, { workspaceId, ownerId: userId })
  notifyAudiences(query, [{ workspaceId, ownerId: userId }, ...removed,
    ...grants.map(row => ({ workspaceId, ownerId: row.ownerId, subjectKind: 'account', subjectId: row.actorId }))])
  return stopped
}

/** Expired/deleted human sessions have a durable trigger-written receipt. This
 * handler is shared by sign-out and the existing due timer, including retries. */
export async function expireResourceAuthority(userId?: string) {
  return db.transaction(tx => withDatabaseTransaction(tx, async () => {
    const query = pool
    const { rows: expired } = await query.query<Audience & { resourceKind: string; resourceId: string; subjectKind: string; subjectId: string }>(`select g."resourceKind",g."resourceId",g."subjectKind",g."subjectId",p."workspaceId",p."ownerId"
      from resource_access_grants g join resource_access_policies p on p.kind=g."resourceKind" and p.id=g."resourceId" where g."expiresAt"<=clock_timestamp()
      order by g."expiresAt",g."resourceKind",g."resourceId" limit 100`)
    const roots = JSON.stringify([...new Map(expired.map(row => [`${row.resourceKind}:${row.resourceId}`, { kind: row.resourceKind, id: row.resourceId }])).values()])
    if (expired.length) {
      await query.query(`select p.kind,p.id from resource_access_policies p join jsonb_to_recordset($1::jsonb) r(kind text,id uuid)
        on p.kind=r.kind and p.id=r.id order by p.kind,p.id for update of p`, [roots])
      await query.query(`select set_config('mikka.acl_source','grant_expired',true)`)
      await query.query(`delete from resource_access_grants g using jsonb_to_recordset($1::jsonb)
        r("resourceKind" text,"resourceId" uuid,"subjectKind" text,"subjectId" text)
        where g."resourceKind"=r."resourceKind" and g."resourceId"=r."resourceId"
          and g."subjectKind"=r."subjectKind" and g."subjectId"=r."subjectId" and g."expiresAt"<=clock_timestamp()`, [JSON.stringify(expired)])
    }
    const { rows: grants } = await query.query<{ id: string; workspaceId: string; ownerId: string; actorId: string }>(`select id,"workspaceId","ownerId","actorId" from thread_execution_grants
      where "revokedAt" is null and "expiresAt"<=clock_timestamp() order by id limit 100 for update`)
    if (grants.length) await query.query('update thread_execution_grants set "revokedAt"=clock_timestamp(),revision=revision+1 where id=any($1::uuid[])', [grants.map(row => row.id)])
    const { rows: receipts } = await query.query<{ id: string; workspaceId: string; ownerId: string; actorId: string }>(`select a.id,a."workspaceId",a."ownerId",a."actorId" from thread_execution_authorizations a
      join thread_execution_grants g on g.id=a."grantId"
      left join "session" s on s.id=a."sessionId" and s."userId"=a."actorId"
      where a."releasedAt" is null and ($1::text is null or a."actorId"=$1)
        and (a."expiresAt"<=clock_timestamp() or g."revokedAt" is not null or g."expiresAt"<=clock_timestamp()
          or s.id is null or s."expiresAt"<=clock_timestamp()
          or exists(select 1 from resource_session_revocations v where v."sessionId"=a."sessionId" and v."deliveredAt" is null)
          or not mikka_resource_acl_allowed('account',a."actorId",a."workspaceId",'thread',a."threadId",'canSteer'))
      order by a.id limit 200 for update of a`, [userId ?? null])
    const receiptIds = receipts.map(row => row.id)
    if (receiptIds.length) await query.query('update thread_execution_authorizations set "releasedAt"=clock_timestamp() where id=any($1::uuid[])', [receiptIds])
    const { rows: runs } = await query.query<{ id: string }>(`with recursive descendants as (
      select p.kind,p.id,0 as depth from resource_access_policies p join jsonb_to_recordset($1::jsonb) r(kind text,id uuid) on p.kind=r.kind and p.id=r.id
      union all select p.kind,p.id,d.depth+1 from descendants d join resource_access_policies p on p."parentKind"=d.kind and p."parentId"=d.id where d.depth<32
    ) select distinct r.id from agent_runs r where
      (r.id in(select id from descendants where kind='thread') or r."issueId" in(select id from descendants where kind='task')
        or r."agentDefinition"#>>'{executionIdentity,collaborationAuthorizationId}'=any($2::text[]))`, [roots, receiptIds])
    const stopped = await stopResourceRuns(query, runs.map(row => row.id), 'authority_expired')
    const hostedOwners = new Map(expired.filter(row => row.ownerId).map(row => [`${row.workspaceId}:${row.ownerId}`, { workspaceId: row.workspaceId, ownerId: row.ownerId! }]))
    for (const scope of hostedOwners.values()) await stopHostedExecutions(query, scope)
    notifyAudiences(query, [...expired, ...grants, ...receipts].map(row => ({ ...row,
      ...('actorId' in row ? { subjectKind: 'account', subjectId: row.actorId } : {}) })))
    await query.query(`update resource_session_revocations set "deliveredAt"=clock_timestamp()
      where "deliveredAt" is null and ($1::text is null or "actorId"=$1)
        and not exists(select 1 from thread_execution_authorizations a where a."sessionId"=resource_session_revocations."sessionId" and a."releasedAt" is null)`, [userId ?? null])
    return { stoppedRuns: stopped.length, expiredGrants: expired.length, expiredAuthorizations: receiptIds.length }
  }))
}

/** Native auth calls this only after its transaction commits. A failed drain
 * leaves the durable receipt and arms the existing retry owner. */
export async function sessionResourceAuthorityChanged(userId: string) {
  try {
    const { rows } = await pool.query('select 1 from resource_session_revocations where "actorId"=$1 and "deliveredAt" is null limit 1', [userId])
    if (!rows.length) return
    armDueTimerSoon('run-recovery')
    await expireResourceAuthority(userId)
  }
  catch (error) { console.warn('Session execution revocation deferred', { name: error instanceof Error ? error.name : 'UnknownError' }) }
}
