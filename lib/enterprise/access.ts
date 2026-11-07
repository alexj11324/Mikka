import 'server-only'
import { pool } from '@/lib/db'
import { workspaceDb } from '@/lib/workspace-db'
import { eq, inArray } from 'drizzle-orm'
import { organizationWorkspaces } from '@/lib/db/governance-schema'
import { actingContext } from '@/lib/activity-actor'
import { WorkspaceError } from '@/lib/workspace-error'
import { enterprisePrincipal, type EnterprisePrincipal, type EnterpriseReader } from './principal'
import { enterpriseAccessAllowed, type EnterpriseAccessState } from './access-policy'
export { enterpriseAccessAllowed } from './access-policy'

async function currentPrincipal(userId: string, explicit?: EnterprisePrincipal): Promise<EnterprisePrincipal | undefined> {
  if (explicit) return explicit
  const acting = actingContext.getStore()
  if (acting) return acting.userId === userId ? acting.enterprisePrincipal : undefined
  const { getSession } = await import('@/lib/session')
  const session = await getSession()
  return session?.user.id === userId ? { kind: 'session', sessionId: session.session.id } : undefined
}

/** Additional tenant gate. It never replaces workspace membership or grants organization admins a workspace. */
export type WorkspaceLinkExecutor = Pick<typeof workspaceDb, 'select'>
export async function enterpriseWorkspaceAllowed(userId: string, workspaceId: string, explicit?: EnterprisePrincipal, executor: WorkspaceLinkExecutor = workspaceDb): Promise<boolean> {
  const links = await executor.select({ organizationId: organizationWorkspaces.organizationId }).from(organizationWorkspaces).where(eq(organizationWorkspaces.workspaceId, workspaceId)).limit(1)
  const organizationId = links[0]?.organizationId
  if (!organizationId) return true
  return organizationAccess(userId, workspaceId, organizationId, explicit)
}
async function organizationAccess(userId: string, workspaceId: string, organizationId: string, explicit?: EnterprisePrincipal) {
  const { rows } = await pool.query<{ enforceSso: boolean; allowMachineCredentials: boolean; managedRevoked: boolean }>(`select
    coalesce((select "enforceSso" from enterprise_org_policy where "organizationId"=$1),false) as "enforceSso",
    coalesce((select "allowMachineCredentials" from enterprise_org_policy where "organizationId"=$1),false) as "allowMachineCredentials",
    (exists(select 1 from enterprise_org_policy where "organizationId"=$1 and "archivedAt" is not null) or exists(select 1 from enterprise_scim_user u join enterprise_scim_connection c on c.id=u."connectionId"
      join enterprise_sso_provider p on p."providerId"=c."providerId"
      where u."organizationId"=$1 and u."userId"=$2 and (not u.active or u.deleted or c."revokedAt" is not null or not p."domainVerified"))) as "managedRevoked"`, [organizationId, userId])
  const state: EnterpriseAccessState = { ...rows[0], credentialValid: false, sessionAssured: false, breakGlass: false }
  if (state.managedRevoked) return false
  if (!state.enforceSso) return true
  const principal = await currentPrincipal(userId, explicit)
  if (principal?.kind === 'session') {
    const { rows: sessions } = await pool.query<{ assured: boolean; breakGlass: boolean }>(`select
      (s."enterpriseOrganizationId"=$3 and exists(select 1 from enterprise_identity i join enterprise_sso_provider p on p."providerId"=i."providerId"
        where i.id::text=s."enterpriseIdentityId" and i."userId"=$2 and p."organizationScopeId"=$3::uuid and p."domainVerified" and p."providerId"=s."enterpriseProviderId"
          and (i."directoryUserId" is null or exists(select 1 from enterprise_scim_user u join enterprise_scim_connection c on c.id=u."connectionId"
            where u.id=i."directoryUserId" and u."userId"=$2 and u.active and not u.deleted and c."revokedAt" is null)))) as assured,
      exists(select 1 from enterprise_break_glass b where b."sessionId"=s.id and b."organizationId"=$3::uuid and b."userId"=$2 and b."expiresAt">now()) as "breakGlass"
      from session s where s.id=$1 and s."userId"=$2 and s."expiresAt">now()`, [principal.sessionId, userId, organizationId])
    state.credentialValid = !!sessions[0]
    state.sessionAssured = sessions[0]?.assured === true
    state.breakGlass = sessions[0]?.breakGlass === true
  } else if (principal?.kind === 'pat' && principal.workspaceId === workspaceId) {
    const { rows: tokens } = await pool.query('select id from personal_access_tokens where id=$1 and "userId"=$2 and "workspaceId"=$3 and "revokedAt" is null and ("expiresAt" is null or "expiresAt">now())', [principal.tokenId, userId, workspaceId])
    state.credentialValid = !!tokens[0]
  } else if (principal?.kind === 'delegation' && (!principal.workspaceId || principal.workspaceId === workspaceId)) {
    const { rows: credentials } = principal.credentialKind === 'run'
      ? await pool.query(`select t.id from run_tokens t join agent_runs r on r.id=t."runId" where t.id=$1 and t."userId"=$2 and r."workspaceId"=$3 and t."revokedAt" is null and t."expiresAt">now()`, [principal.credentialId, userId, workspaceId])
      : await pool.query(`select t.id from "oauthAccessToken" t join "oauthClient" c on c."clientId"=t."clientId" left join session s on s.id=t."sessionId"
          where t.id=$1 and t."userId"=$2 and t.revoked is null and t."expiresAt">now() and coalesce(c.disabled,false)=false and (t."sessionId" is null or s."expiresAt">now())`, [principal.credentialId, userId])
    state.credentialValid = !!credentials[0]
  } else if (principal?.kind === 'admission' && principal.workspaceId === workspaceId) {
    // Host admission is durable provenance written by the existing claim path; a system actor alone is never sufficient.
    const { rows: runs } = await pool.query(`select id from agent_runs where id=$1 and "userId"=$2 and "workspaceId"=$3
      and "machineAuthority"=true and "stopRequestedAt" is null and status in ('preparing','running','waiting_input','finishing')
      and "agentDefinition"->'executionIdentity'->>'workspaceId'=$3::text
      and "agentDefinition"->'executionIdentity'->>'requester'=$2`, [principal.runId, userId, workspaceId])
    state.credentialValid = !!runs[0]
  }
  return enterpriseAccessAllowed(state, principal)
}

/** Organization administration has its own role check; this only enforces its authentication policy. */
export async function requireEnterpriseOrganization(userId: string, organizationId: string, sessionId: string) {
  if (!await organizationAccess(userId, '', organizationId, { kind: 'session', sessionId })) throw new WorkspaceError('workspaceAccessDenied')
}

export async function requireEnterpriseWorkspace(userId: string, workspaceId: string, principal?: EnterprisePrincipal, executor?: WorkspaceLinkExecutor) {
  if (!await enterpriseWorkspaceAllowed(userId, workspaceId, principal, executor)) throw new WorkspaceError('workspaceAccessDenied')
}
export async function filterEnterpriseWorkspaces<T extends { id: string }>(reader: string | EnterpriseReader, workspaces: T[]): Promise<T[]> {
  const userId = typeof reader === 'string' ? reader : reader.id
  const principal = typeof reader === 'string' ? undefined : reader[enterprisePrincipal]
  if (!workspaces.length) return workspaces
  const links = await workspaceDb.select().from(organizationWorkspaces).where(inArray(organizationWorkspaces.workspaceId, workspaces.map(workspace => workspace.id)))
  const organizations = new Map(links.map(link => [link.workspaceId, link.organizationId]))
  const checks = await Promise.all(workspaces.map(workspace => {
    const organizationId = organizations.get(workspace.id)
    return organizationId ? organizationAccess(userId, workspace.id, organizationId, principal) : true
  }))
  return workspaces.filter((_, index) => checks[index])
}
