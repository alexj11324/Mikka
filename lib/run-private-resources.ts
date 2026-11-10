import 'server-only'
import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { ActionFailureError } from '@/lib/action-error'
import type { ResourceExecutor } from '@/lib/resource-access/store'

export type RunResourceContext = {
  runId: string; workspaceId: string; ownerId: string; actorId: string;
  personalResources: boolean; snapshot: string;
  /** Nearest ancestors first. All share the exact tenant and the effective ACL. */
  scopes: Array<{ kind: 'project' | 'thread'; id: string; depth: number }>;
}

/** Content authority is an intersection with the real actor, not a synonym
 * for the native CLI account or the person who owns the VM. No plaintext is read. */
export async function runResourceContext(runId: string, workspaceId: string, ownerId: string,
  query: ResourceExecutor = db): Promise<RunResourceContext> {
  const { rows } = await query.execute<{ kind: string; id: string; depth: number; revision: number;
    actorId: string; personalResources: boolean; allowed: boolean }>(sql`
    with recursive ancestry as (
      select p.*,0 as depth from resource_access_policies p where p.kind='thread' and p.id=${runId}::uuid
      union all select p.*,a.depth+1 from ancestry a join resource_access_policies p
        on p.kind=a."parentKind" and p.id=a."parentId" where a.depth<32
    ) select a.kind,a.id,a.depth,a.revision,
      coalesce(r."agentDefinition"->'executionIdentity'->>'actor',r."userId") as "actorId",
      mikka_run_personal_resources_allowed(r.id) as "personalResources",
      r."userId"=${ownerId} and r."workspaceId"=${workspaceId}::uuid
        and mikka_resource_acl_allowed('account',r."userId",r."workspaceId",'thread',r.id,'canSteer')
        and mikka_resource_acl_allowed('account',coalesce(r."agentDefinition"->'executionIdentity'->>'actor',r."userId"),r."workspaceId",'thread',r.id,'canSteer') as allowed
      from agent_runs r cross join ancestry a where r.id=${runId}::uuid order by a.depth,a.kind,a.id`)
  if (!rows.length || rows.some(row => !row.allowed || row.depth >= 32)) throw new ActionFailureError('issueNotFound')
  const { actorId, personalResources } = rows[0]
  const snapshot = createHash('sha256').update(JSON.stringify([runId, workspaceId, ownerId, actorId, personalResources,
    rows.map(row => [row.kind, row.id, row.revision])])).digest('hex')
  return { runId, workspaceId, ownerId, actorId, personalResources, snapshot,
    scopes: rows.flatMap(row => row.kind === 'project' || row.kind === 'thread' ? [{ kind: row.kind, id: row.id, depth: row.depth }] : []) }
}

/** Used at Git/MCP/Memory delivery boundaries. Workspace membership and the
 * frozen execution identity remain independently checked by those callers. */
export async function runPersonalResourcesAllowed(query: Pick<Pool | PoolClient, 'query'>,
  runId: string, ownerId: string): Promise<boolean> {
  const { rows: [row] } = await query.query<{ allowed: boolean }>(`SELECT mikka_run_personal_resources_allowed(id) AS allowed
    FROM agent_runs WHERE id=$1 AND "userId"=$2`, [runId, ownerId])
  return row?.allowed === true
}

/** Pre-insert queues use their exact Task/source Thread. An exclusive private
 * ancestor remains authoritative; a new sharing grant invalidates it at once. */
export async function resourcePersonalResourcesAllowed(query: Pick<Pool | PoolClient, 'query'>,
  kind: 'project' | 'task' | 'thread', id: string, ownerId: string): Promise<boolean> {
  const { rows: [row] } = await query.query<{ allowed: boolean }>(
    'SELECT mikka_resource_personal_resources_allowed($1,$2::uuid,$3) AS allowed', [kind, id, ownerId])
  return row?.allowed === true
}

/** A shared execution uses a clean dedicated cloud environment. Absence of a
 * disclosure receipt does not attest an old VM or a personal local device. */
export async function runCleanExecutionAllowed(query: Pick<Pool | PoolClient, 'query'>,
  runId: string, deviceId: string): Promise<boolean> {
  const { rows: [row] } = await query.query<{ allowed: boolean }>(
    'SELECT mikka_run_clean_execution_allowed($1::uuid,$2::uuid) AS allowed', [runId, deviceId])
  return row?.allowed === true
}

type ModelCredentialProvenance = { credentialKind: 'legacy_unknown' | 'api_key' | 'subscription' | 'native_login'; credentialId: string | null; credentialOwnerId: string | null }

/** A separate, live collaboration receipt authorizes this exact API key. This
 * guard additionally checks immutable VM/session history before reservation. */
export async function runModelCredentialHistoryAllowed(query: Pick<Pool | PoolClient, 'query'>, input: {
  sourceRunId: string; deviceId: string; actorId: string; executionOwnerId: string;
  credentialKind: 'api_key' | 'subscription' | 'native_login'; credentialId: string; credentialOwnerId: string;
}): Promise<boolean> {
  const { rows: [row] } = await query.query<{ allowed: boolean }>(
    'SELECT mikka_run_model_credential_history_allowed($1::uuid,$2::uuid,$3,$4,$5,$6,$7) AS allowed',
    [input.sourceRunId, input.deviceId, input.actorId, input.executionOwnerId, input.credentialKind, input.credentialId, input.credentialOwnerId])
  return row?.allowed === true
}

/** Called in the final claim transaction, after ACL and Secret snapshots were
 * rechecked. A historical disclosure can never be relabeled clean. */
export async function recordRunResourceDisclosure(query: ResourceExecutor, context: RunResourceContext,
  run: { id: string; attempt: number; deviceId: string | null }): Promise<boolean> {
  if (run.id !== context.runId || !run.deviceId || !Number.isSafeInteger(run.attempt) || run.attempt < 1) return false
  // Different native attempts can share a retained VM. Serialize their sticky
  // disclosure writes without taking a second run lock in the opposite order.
  await query.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`resource-disclosure-device:${run.deviceId}`},0))`)
  const { rows: [current] } = await query.execute<{ allowed: boolean } & ModelCredentialProvenance>(sql`
    select mikka_run_clean_execution_allowed(r.id,${run.deviceId}::uuid)
      and mikka_run_personal_resources_allowed(r.id)=${context.personalResources}
      and r."userId"=${context.ownerId} and r."workspaceId"=${context.workspaceId}::uuid
      and coalesce(r."agentDefinition"->'executionIdentity'->>'actor',r."userId")=${context.actorId}
      and mikka_resource_acl_allowed('account',${context.actorId},r."workspaceId",'thread',r.id,'canSteer') as allowed,
      credential."credentialKind",credential."credentialId",credential."credentialOwnerId"
      from agent_runs r cross join lateral mikka_run_model_credential_provenance(r.id) credential where r.id=${run.id}::uuid`)
  if (!current?.allowed) return false
  const { rows: [prior] } = await query.execute<{ personalResources: boolean; actorId: string; deviceId: string | null } & ModelCredentialProvenance>(sql`
    select "personalResources","actorId","deviceId","credentialKind","credentialId","credentialOwnerId" from run_resource_disclosures
    where "runId"=${run.id}::uuid and attempt=${run.attempt}`)
  if (prior && (prior.actorId !== context.actorId || prior.deviceId !== run.deviceId
    || prior.personalResources !== context.personalResources || prior.credentialKind !== current.credentialKind
    || prior.credentialId !== current.credentialId || prior.credentialOwnerId !== current.credentialOwnerId)) return false
  if (context.personalResources) await query.execute(sql`update thread_machines set "resourceIsolation"='owner_private'
    where "runId"=${run.id}::uuid and "deviceId"=${run.deviceId}::uuid`)
  if (prior) return true
  await query.execute(sql`insert into run_resource_disclosures("runId",attempt,"workspaceId","ownerId","actorId","deviceId","personalResources","policySnapshot",provenance,"credentialKind","credentialId","credentialOwnerId")
    values(${run.id}::uuid,${run.attempt},${context.workspaceId}::uuid,${context.ownerId},${context.actorId},${run.deviceId}::uuid,
      ${context.personalResources},${context.snapshot},'claim',${current.credentialKind},${current.credentialId},${current.credentialOwnerId})`)
  return true
}
