import 'server-only'
import type { Pool, PoolClient } from 'pg'
import type { HostedQuotaLease } from '@/lib/abuse/store'
import { deploymentMode } from './edition'
import { resolveEntitlements, type DeploymentMode, type PlanGrant } from './policy'
import { GovernanceError } from './errors'

/** Product quota only. This function cannot authenticate a caller or authorize a model call. */
export async function acquireHostedQuota(workspaceId: string, database?: Pick<Pool, 'connect'>, mode: DeploymentMode = deploymentMode()): Promise<HostedQuotaLease> {
  const target = database ?? (await import('@/lib/workspace-db')).workspacePool
  const client: PoolClient = await target.connect()
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    try { await client.query('ROLLBACK'); client.release() }
    catch (error) { client.release(error instanceof Error ? error : new Error('governance_quota_cleanup', { cause: error })); throw error }
  }
  try {
    await client.query('BEGIN')
    await client.query("set local lock_timeout='5s'; set local statement_timeout='5s'; set local idle_in_transaction_session_timeout='30s'")
    const { rows: [workspace] } = await client.query<{ kind: 'personal' | 'team' }>('select kind from mikka_workspaces where id=$1 for share', [workspaceId])
    if (!workspace) throw new GovernanceError('not_found')
    const { rows: [link] } = await client.query<{ organizationId: string }>('select "organizationId" from mikka_organization_workspaces where "workspaceId"=$1', [workspaceId])
    if (link) await client.query('select id from mikka_organizations where id=$1 for share', [link.organizationId])
    const { rows: [grant] } = link
      ? await client.query<PlanGrant>('select plan,source,"seatLimit","expiresAt" from mikka_organization_entitlements where "organizationId"=$1', [link.organizationId])
      : await client.query<PlanGrant>('select plan,source,"seatLimit","expiresAt" from mikka_workspace_entitlements where "workspaceId"=$1', [workspaceId])
    return { limit: resolveEntitlements({ mode, kind: workspace.kind, grant }).hostedMaxInFlight, close }
  } catch (error) { await close(); throw error }
}
