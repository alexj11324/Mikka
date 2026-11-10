import type { Pool, PoolClient } from 'pg'
import { runChanged } from './live/panels'
import { runListChanged } from './live/lists'
import { runControlChanged } from './device-gateway-notify'
import { armDueTimerAfterCommit } from './due-timer'
import { workspaceResourcePolicy } from './governance/resource-access'
import { WorkspaceError } from './workspace-error'

type Query = Pick<Pool | PoolClient, 'query'>

/** This legacy switch controls explicitly shared personal API keys only.
 * #1849 keeps subscriptions account-owned in every authorized Workspace. */
export async function memberSubscriptionsAllowed(query: Query, workspaceId: string): Promise<boolean> {
  if ((await workspaceResourcePolicy(workspaceId)).modelCredentialSharing === 'deny') return false
  const { rows: [row] } = await query.query<{ subscriptions: boolean }>('SELECT subscriptions FROM workspace_personal_policies WHERE "workspaceId"=$1', [workspaceId])
  return row?.subscriptions ?? true
}

/** Compatibility readers cannot revive historical subscription-sharing grants. */
export async function othersMayUse(_query: Query, _ownerId: string, _workspaceId: string): Promise<boolean> {
  return false
}

/** A personal subscription never appears in another member's model pool. */
export async function pooledOwners(_query: Query, _runOwnerId: string, _workspaceId: string): Promise<string[]> {
  return []
}

/** Legacy clients may withdraw sharing, but may not grant subscription use.
 * The owner's own use in each authorized Workspace needs no share row. */
export async function setSubscriptionShare(query: Query, ownerId: string, workspaceId: string, shared: boolean, allowOthers?: boolean) {
  if (allowOthers === true) throw new WorkspaceError('subscriptionPersonalOnly')
  if (!shared) {
    await query.query('DELETE FROM workspace_subscription_shares WHERE "ownerId"=$1 AND "workspaceId"=$2', [ownerId, workspaceId])
  } else {
    await query.query(`INSERT INTO workspace_subscription_shares ("ownerId","workspaceId","allowOthers") VALUES ($1,$2,false)
      ON CONFLICT ("ownerId","workspaceId") DO UPDATE SET "allowOthers"=false`, [ownerId, workspaceId])
  }
  await stopRunsUsingSubscriptions(query, { ownerId, workspaceId, othersOnly: true })
}

/** Withdraw through the existing stop request, lease cut and push channel.
 * No per-model or per-tool control-plane proxy is introduced. */
export async function stopRunsUsingSubscriptions(query: Query, scope: { ownerId?: string; workspaceId?: string; connectionId?: string; othersOnly?: boolean }) {
  if (!scope.workspaceId && !scope.connectionId) throw new Error('stopRunsUsingSubscriptions needs a workspace or a connection')
  const { rowCount, rows } = await query.query<{ id: string }>(`UPDATE agent_runs r SET "stopRequestedAt"=clock_timestamp(),
      "leaseExpiresAt"=LEAST(r."leaseExpiresAt",clock_timestamp()),"updatedAt"=clock_timestamp()
    FROM byos_native_runs n JOIN byos_bindings b ON b.id=n."bindingId" JOIN byos_connections c ON c.id=b."connectionId"
    WHERE n."runId"=r.id AND r."stopRequestedAt" IS NULL AND r.status IN ('queued','preparing','running','paused','waiting_input','finishing')
      AND ($1::text IS NULL OR c."ownerId"=$1) AND ($2::text IS NULL OR b."workspaceId"::text=$2)
      AND ($3::uuid IS NULL OR c.id=$3) AND (NOT $4::boolean OR r."userId"<>c."ownerId") RETURNING r.id`,
    [scope.ownerId ?? null, scope.workspaceId ?? null, scope.connectionId ?? null, scope.othersOnly ?? false])
  for (const { id } of rows) { await runListChanged(query, id); await runChanged(query, id) }
  runControlChanged(query, { runIds: rows.map(row => row.id) })
  if (rows.length) armDueTimerAfterCommit(query, 'run-recovery')
  return rowCount ?? 0
}

/** Every broker/claim/renewal/worker boundary requires the personal owner.
 * Keep the Workspace expression typed for callers' stable SQL parameters. */
export const runMayUseCredentialSql = (credentialOwner: string, runOwner: string, workspace: string) =>
  `(${credentialOwner}=${runOwner} AND (${workspace})::text IS NOT NULL)`

/** Legacy fallback cannot create a binding to another account. */
export async function sharedNativeBinding(_query: Query, _runOwnerId: string, _agentId: string, _harness: string, _workspaceId: string): Promise<string | null> {
  return null
}
