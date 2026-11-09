import 'server-only'
import type { PoolClient } from 'pg'
import { deploymentMode } from './edition'
import { resolveEntitlements, type PlanGrant } from './policy'
import { GovernanceError } from './errors'

/** The caller owns a membership lease through its APP commit. Only shared locks here. */
export async function readGovernanceLease(client: Pick<PoolClient, 'query'>, workspaceId: string, userId: string) {
  const { rows: [workspace] } = await client.query<{ kind: 'personal' | 'team'; role: 'admin' | 'member' }>('select w.kind,m.role from mikka_workspaces w join mikka_workspace_members m on m."workspaceId"=w.id where w.id=$1 and m."userId"=$2 and m.status=\'active\' for share of w,m', [workspaceId, userId])
  if (!workspace) throw new GovernanceError('access_denied')
  const { rows: [link] } = await client.query<{ organizationId: string }>('select "organizationId" from mikka_organization_workspaces where "workspaceId"=$1', [workspaceId])
  if (link) await client.query('select id from mikka_organizations where id=$1 for share', [link.organizationId])
  const { rows: [grant] } = link
    ? await client.query<PlanGrant>('select plan,source,"seatLimit","expiresAt" from mikka_organization_entitlements where "organizationId"=$1', [link.organizationId])
    : await client.query<PlanGrant>('select plan,source,"seatLimit","expiresAt" from mikka_workspace_entitlements where "workspaceId"=$1', [workspaceId])
  return { role: workspace.role, organizationId: link?.organizationId ?? null, entitlements: resolveEntitlements({ mode: deploymentMode(), kind: workspace.kind, grant }) }
}
