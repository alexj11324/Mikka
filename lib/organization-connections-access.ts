import type { Pool, PoolClient } from 'pg'
import { readModelPolicy, type OrganizationModelPolicy } from './organization-model-policy'

type Query = Pick<Pool | PoolClient, 'query'>
export type OrganizationConnectionAuthority = { organizationId: string; name: string; revision: number; modelPolicy: OrganizationModelPolicy }

/** Both memberships and the tenant link are re-read. Being an Org admin does not grant Workspace access. */
export async function organizationConnectionAuthority(workspaceId: string, userId: string, membership?: Query): Promise<OrganizationConnectionAuthority | null> {
  const query = membership ?? (await import('./workspace-db')).workspacePool
  const { rows: [row] } = await query.query<{ organizationId: string; name: string; revision: number | null; modelPolicy: unknown }>(`SELECT o.id AS "organizationId",o.name,p.revision,to_jsonb(p)->'modelPolicy' AS "modelPolicy"
    FROM mikka_organization_workspaces l JOIN mikka_organizations o ON o.id=l."organizationId" AND o."archivedAt" IS NULL
    JOIN mikka_workspaces w ON w.id=l."workspaceId" AND w.kind='team'
    JOIN mikka_organization_members om ON om."organizationId"=o.id AND om."userId"=$2 AND om.status='active'
    JOIN mikka_workspace_members wm ON wm."workspaceId"=w.id AND wm."userId"=$2 AND wm.status='active'
    LEFT JOIN mikka_organization_resource_policies p ON p."organizationId"=o.id WHERE l."workspaceId"=$1`, [workspaceId, userId])
  return row ? { ...row, revision: row.revision ?? 0, modelPolicy: readModelPolicy(row.modelPolicy) } : null
}

/** Policy applies to all candidates, including personal ones, while personal ownership stays unchanged. */
export async function workspaceModelPolicy(workspaceId: string, membership?: Query): Promise<OrganizationModelPolicy> {
  const query = membership ?? (await import('./workspace-db')).workspacePool
  const { rows: [row] } = await query.query<{ modelPolicy: unknown }>(`SELECT to_jsonb(p)->'modelPolicy' AS "modelPolicy"
    FROM mikka_organization_workspaces l JOIN mikka_organization_resource_policies p ON p."organizationId"=l."organizationId"
    WHERE l."workspaceId"=$1`, [workspaceId])
  return readModelPolicy(row?.modelPolicy)
}
