import type { Pool, PoolClient } from 'pg'
import type { SharedResourceKind, SharingRule } from '@/lib/db/governance-schema'
import { GovernanceError } from './errors'

type Query = Pick<Pool | PoolClient, 'query'>
export type OrganizationResourcePolicy = {
  organizationId: string | null; modelCredentialSharing: SharingRule; mcpSharing: SharingRule; allowedModelProviders: string[] | null
}

/** Re-read at the existing authority boundary; no cache can turn an organization deny into a grant. */
export async function workspaceResourcePolicy(workspaceId: string, membership?: Query): Promise<OrganizationResourcePolicy> {
  const query = membership ?? (await import('@/lib/workspace-db')).workspacePool
  const { rows: [row] } = await query.query<{ kind: string } & OrganizationResourcePolicy>(`select w.kind,l."organizationId",p."modelCredentialSharing",p."mcpSharing",p."allowedModelProviders"
    from mikka_workspaces w left join mikka_organization_workspaces l on l."workspaceId"=w.id
    left join mikka_organization_resource_policies p on p."organizationId"=l."organizationId" where w.id=$1`, [workspaceId])
  if (!row) throw new GovernanceError('access_denied')
  if (row.kind === 'personal' || !row.organizationId) return { organizationId: null, modelCredentialSharing: 'allow', mcpSharing: 'allow', allowedModelProviders: null }
  return { organizationId: row.organizationId, modelCredentialSharing: row.modelCredentialSharing ?? 'allow', mcpSharing: row.mcpSharing ?? 'allow', allowedModelProviders: row.allowedModelProviders ?? null }
}

/** Only a borrowed resource calls this helper. A person's own credentials remain their own. */
export async function organizationResourceAllowed(workspaceId: string, kind: SharedResourceKind, resourceId: string, ownerId: string, membership?: Query) {
  const query = membership ?? (await import('@/lib/workspace-db')).workspacePool
  const policy = await workspaceResourcePolicy(workspaceId, query)
  if (!policy.organizationId) return true
  // Sharing a Skill is a sharing of the owner's integration content, so it
  // follows the same organization switch as a shared MCP connection.
  const rule = kind === 'mcp' || kind === 'skill' ? policy.mcpSharing : policy.modelCredentialSharing
  if (rule === 'deny') return false
  const { rows: [approval] } = await query.query<{ status: string }>(`select status from mikka_organization_resource_approvals
    where "organizationId"=$1 and "workspaceId"=$2 and kind=$3 and "resourceId"=$4 and "ownerId"=$5`, [policy.organizationId, workspaceId, kind, resourceId, ownerId])
  if (approval?.status === 'denied') return false
  return rule === 'allow' || approval?.status === 'approved'
}

export async function assertOrganizationResourceShare(workspaceId: string, kind: SharedResourceKind, resourceId: string, ownerId: string, membership?: Query) {
  if (!(await organizationResourceAllowed(workspaceId, kind, resourceId, ownerId, membership))) throw new GovernanceError('access_denied')
}

export async function assertOrganizationModelProvider(workspaceId: string, provider: string, membership?: Query) {
  const policy = await workspaceResourcePolicy(workspaceId, membership)
  if (policy.allowedModelProviders !== null && !policy.allowedModelProviders.includes(provider)) throw new GovernanceError('access_denied')
  return policy.allowedModelProviders !== null
}
