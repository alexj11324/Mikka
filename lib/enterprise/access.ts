import 'server-only'
import { pool } from '@/lib/db'
import { workspaceDb } from '@/lib/workspace-db'
import { eq, inArray } from 'drizzle-orm'
import type { PoolClient } from 'pg'
import { organizationWorkspaces } from '@/lib/db/governance-schema'
import { actingContext } from '@/lib/activity-actor'
import { WorkspaceError } from '@/lib/workspace-error'
import { enterprisePrincipal, type EnterprisePrincipal, type EnterpriseReader } from './principal'
import { enterpriseAccessAllowed, type EnterpriseAccessState } from './access-policy'
import { currentExecutionAuthority } from './execution-authority'
export { enterpriseAccessAllowed } from './access-policy'

type AccessPrincipal = EnterprisePrincipal | { kind: 'execution'; credentialValid: boolean }
async function currentPrincipal(userId: string, workspaceId: string, explicit: EnterprisePrincipal | undefined, query: EnterpriseAuthExecutor): Promise<AccessPrincipal | undefined> {
  // Original human/delegated proof always wins, including when it has expired
  // or lost SSO assurance. Background work cannot silently replace that actor.
  if (explicit) return explicit
  const acting = actingContext.getStore()
  if (acting && acting.userId !== userId) return undefined
  if (acting?.enterprisePrincipal) return acting.enterprisePrincipal
  if (acting?.tokenWorkspaceId && acting.tokenWorkspaceId !== workspaceId) return undefined
  const execution = await currentExecutionAuthority(userId, workspaceId, query)
  if (execution !== undefined) return { kind: 'execution', credentialValid: execution }
  if (acting) return undefined
  const { getSession } = await import('@/lib/session')
  const session = await getSession()
  return session?.user.id === userId ? { kind: 'session', sessionId: session.session.id } : undefined
}

/** Additional tenant gate. It never replaces workspace membership or grants organization admins a workspace. */
export type WorkspaceLinkExecutor = Pick<typeof workspaceDb, 'select'>
export type EnterpriseAuthExecutor = Pick<PoolClient, 'query'>
export async function enterpriseWorkspaceAllowed(userId: string, workspaceId: string, explicit?: EnterprisePrincipal, executor: WorkspaceLinkExecutor = workspaceDb, appExecutor: EnterpriseAuthExecutor = pool): Promise<boolean> {
  const links = await executor.select({ organizationId: organizationWorkspaces.organizationId }).from(organizationWorkspaces).where(eq(organizationWorkspaces.workspaceId, workspaceId)).limit(1)
  const organizationId = links[0]?.organizationId
  if (!organizationId) return true
  return organizationAccess(userId, workspaceId, organizationId, explicit, appExecutor)
}
async function organizationAccess(userId: string, workspaceId: string, organizationId: string, explicit?: EnterprisePrincipal, appExecutor: EnterpriseAuthExecutor = pool) {
  const { rows } = await appExecutor.query<{ enforceSso: boolean; allowMachineCredentials: boolean; managedRevoked: boolean }>(`select
    coalesce((select "enforceSso" from enterprise_org_policy where "organizationId"=$1),false) as "enforceSso",
    coalesce((select "allowMachineCredentials" from enterprise_org_policy where "organizationId"=$1),false) as "allowMachineCredentials",
    (exists(select 1 from enterprise_org_policy where "organizationId"=$1 and "archivedAt" is not null) or exists(select 1 from enterprise_scim_user u join enterprise_scim_connection c on c.id=u."connectionId"
      join enterprise_sso_provider p on p."providerId"=c."providerId"
      where u."organizationId"=$1 and u."userId"=$2 and (not u.active or u.deleted or c."revokedAt" is not null or not p."domainVerified"))) as "managedRevoked"`, [organizationId, userId])
  const state: EnterpriseAccessState = { ...rows[0], credentialValid: false, sessionAssured: false, breakGlass: false }
  if (state.managedRevoked) return false
  if (!state.enforceSso) return true
  const principal = await currentPrincipal(userId, workspaceId, explicit, appExecutor)
  if (principal?.kind === 'execution') {
    state.credentialValid = principal.credentialValid
  } else if (principal?.kind === 'session') {
    const { rows: sessions } = await appExecutor.query<{ assured: boolean; breakGlass: boolean }>(`select
      (s."enterpriseOrganizationId"=$3 and not exists(select 1 from enterprise_saml_session_lineage lineage
        left join session root on root.id=lineage."rootSessionId" and root."userId"=$2 and root."expiresAt">now()
          and root."enterpriseOrganizationId"=$3 and root."enterpriseProviderId"=s."enterpriseProviderId"
          and root."enterpriseIdentityId"=s."enterpriseIdentityId"
        where lineage."sessionId"=s.id and (root.id is null or lineage."userId"<>$2 or lineage."organizationId"<>$3::uuid
          or lineage."providerId"<>s."enterpriseProviderId" or lineage."identityId"::text<>s."enterpriseIdentityId"))
        and exists(select 1 from enterprise_identity i join enterprise_sso_provider p on p."providerId"=i."providerId"
        where i.id::text=s."enterpriseIdentityId" and i."userId"=$2 and p."organizationScopeId"=$3::uuid and p."domainVerified" and p."providerId"=s."enterpriseProviderId"
          and (i."directoryUserId" is null or exists(select 1 from enterprise_scim_user u join enterprise_scim_connection c on c.id=u."connectionId"
            where u.id=i."directoryUserId" and u."userId"=$2 and u.active and not u.deleted and c."revokedAt" is null)))) as assured,
      exists(select 1 from enterprise_break_glass b where b."sessionId"=s.id and b."organizationId"=$3::uuid and b."userId"=$2 and b."expiresAt">now()) as "breakGlass"
      from session s where s.id=$1 and s."userId"=$2 and s."expiresAt">now()`, [principal.sessionId, userId, organizationId])
    state.credentialValid = !!sessions[0]
    state.sessionAssured = sessions[0]?.assured === true
    state.breakGlass = sessions[0]?.breakGlass === true
  } else if (principal?.kind === 'pat' && principal.workspaceId === workspaceId) {
    const { rows: tokens } = await appExecutor.query('select id from personal_access_tokens where id=$1 and "userId"=$2 and "workspaceId"=$3 and "revokedAt" is null and ("expiresAt" is null or "expiresAt">now())', [principal.tokenId, userId, workspaceId])
    state.credentialValid = !!tokens[0]
  } else if (principal?.kind === 'delegation' && (!principal.workspaceId || principal.workspaceId === workspaceId)) {
    const { rows: credentials } = principal.credentialKind === 'run'
      ? await appExecutor.query(`select t.id from run_tokens t join agent_runs r on r.id=t."runId" where t.id=$1 and t."userId"=$2 and r."workspaceId"=$3 and t."revokedAt" is null and t."expiresAt">now()`, [principal.credentialId, userId, workspaceId])
      : await appExecutor.query(`select t.id from "oauthAccessToken" t join "oauthClient" c on c."clientId"=t."clientId" left join session s on s.id=t."sessionId"
          where t.id=$1 and t."userId"=$2 and t.revoked is null and t."expiresAt">now() and coalesce(c.disabled,false)=false and (t."sessionId" is null or s."expiresAt">now())`, [principal.credentialId, userId])
    state.credentialValid = !!credentials[0]
  } else if (principal?.kind === 'admission' && principal.workspaceId === workspaceId) {
    // Host admission is durable provenance written by the existing claim path; a system actor alone is never sufficient.
    const { rows: runs } = await appExecutor.query(`select id from agent_runs where id=$1 and "userId"=$2 and "workspaceId"=$3
      and "machineAuthority"=true and "stopRequestedAt" is null and status in ('preparing','running','waiting_input','finishing')
      and "agentDefinition"->'executionIdentity'->>'workspaceId'=$3::text
      and "agentDefinition"->'executionIdentity'->>'requester'=$2`, [principal.runId, userId, workspaceId])
    state.credentialValid = !!runs[0]
  } else if (principal?.kind === 'collaboration' && principal.workspaceId === workspaceId) {
    const { collaborationExecutionProof } = await import('./collaboration-authority')
    const proof = await collaborationExecutionProof(appExecutor, { ownerId: userId, workspaceId, authorizationId: principal.authorizationId })
    // The actor retains their own live SSO/SCIM proof. The owner's delegated
    // execution must additionally satisfy the organization's machine policy.
    state.credentialValid = !!proof && await organizationAccess(proof.actorId, workspaceId, organizationId,
      { kind: 'session', sessionId: proof.sessionId }, appExecutor)
  } else if (principal?.kind === 'bot_chat' && principal.workspaceId === workspaceId) {
    const { botChatExecutionProof } = await import('@/lib/collaboration/bot-chat')
    const proof = await botChatExecutionProof(appExecutor, userId, workspaceId, principal.eventId)
    state.credentialValid = !!proof && await organizationAccess(proof.actorId, workspaceId, organizationId, proof.principal, appExecutor)
  }
  return enterpriseAccessAllowed(state, principal)
}

/** Organization administration has its own role check; this only enforces its authentication policy. */
export async function requireEnterpriseOrganization(userId: string, organizationId: string, sessionId: string) {
  if (!await organizationAccess(userId, '', organizationId, { kind: 'session', sessionId })) throw new WorkspaceError('workspaceAccessDenied')
}

export async function requireEnterpriseWorkspace(userId: string, workspaceId: string, principal?: EnterprisePrincipal, executor?: WorkspaceLinkExecutor, appExecutor?: EnterpriseAuthExecutor) {
  if (!await enterpriseWorkspaceAllowed(userId, workspaceId, principal, executor, appExecutor)) throw new WorkspaceError('workspaceAccessDenied')
}
async function filterWorkspaceOrganizations<T extends { id: string }>(reader: string | EnterpriseReader, workspaces: T[], organizations: ReadonlyMap<string, string | null>): Promise<T[]> {
  const userId = typeof reader === 'string' ? reader : reader.id
  const principal = typeof reader === 'string' ? undefined : reader[enterprisePrincipal]
  const checks = await Promise.all(workspaces.map(workspace => {
    const organizationId = organizations.get(workspace.id)
    return organizationId ? organizationAccess(userId, workspace.id, organizationId, principal) : true
  }))
  return workspaces.filter((_, index) => checks[index])
}

/** Canonical linkage comes from a fresh membership SELECT or an active
 * Workspace lock whose same-transaction link writes invalidate its projection.
 * Never pass request-supplied links. Session, directory and organization policy
 * are checked on every call, including reads under the same lock. */
export function filterEnterpriseWorkspaceLinks<T extends { id: string; organizationId: string | null }>(reader: string | EnterpriseReader, workspaces: T[]): Promise<T[]> {
  return filterWorkspaceOrganizations(reader, workspaces, new Map(workspaces.map(workspace => [workspace.id, workspace.organizationId])))
}

export async function filterEnterpriseWorkspaces<T extends { id: string }>(reader: string | EnterpriseReader, workspaces: T[]): Promise<T[]> {
  if (!workspaces.length) return workspaces
  const links = await workspaceDb.select().from(organizationWorkspaces).where(inArray(organizationWorkspaces.workspaceId, workspaces.map(workspace => workspace.id)))
  return filterWorkspaceOrganizations(reader, workspaces, new Map(links.map(link => [link.workspaceId, link.organizationId])))
}

