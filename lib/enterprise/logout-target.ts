import 'server-only'
import { pool } from '@/lib/db'
import type { ApiSession } from '@/lib/api-auth'
import { GovernanceError } from '@/lib/governance/errors'
import { enterprisePrincipal } from './principal'

export type EnterpriseLogoutTarget = { providerId: string; protocol: 'oidc' | 'saml' }

/** Read-only routing for this actual human session. This descriptor grants no
 * access: the existing logout endpoint rechecks the session and audits logout.
 * No selected Workspace, Organization role or caller-supplied provider is used. */
export async function enterpriseLogoutTarget(session: ApiSession): Promise<EnterpriseLogoutTarget | null> {
  const principal = session.user[enterprisePrincipal]
  if (principal?.kind !== 'session' || principal.sessionId !== session.session.id) throw new GovernanceError('access_denied')
  const { rows } = await pool.query<EnterpriseLogoutTarget>(`select p."providerId",
      case when p."oidcConfig" is not null then 'oidc' else 'saml' end as protocol
    from session s join enterprise_identity i on i.id::text=s."enterpriseIdentityId" and i."userId"=s."userId"
      join enterprise_sso_provider p on p."providerId"=i."providerId" and p."providerId"=s."enterpriseProviderId"
    where s.id=$1 and s."userId"=$2 and s."expiresAt">now() and p."domainVerified"
      and p."organizationScopeId"::text=s."enterpriseOrganizationId"
      and s."enterpriseDirectoryUserId" is not distinct from i."directoryUserId"::text
      and not exists(select 1 from enterprise_org_policy x where x."organizationId"=p."organizationScopeId" and x."archivedAt" is not null)
      and not exists(select 1 from enterprise_scim_user u join enterprise_scim_connection c on c.id=u."connectionId"
        join enterprise_sso_provider managed on managed."providerId"=c."providerId"
        where u."organizationId"=p."organizationScopeId" and u."userId"=s."userId"
          and (not u.active or u.deleted or c."revokedAt" is not null or not managed."domainVerified"))
      and (i."directoryUserId" is null or exists(select 1 from enterprise_scim_user u
        join enterprise_scim_connection c on c.id=u."connectionId"
        where u.id=i."directoryUserId" and u."userId"=s."userId" and u."organizationId"=p."organizationScopeId"
          and c."providerId"=p."providerId" and u.active and not u.deleted and c."revokedAt" is null))
      and not exists(select 1 from enterprise_saml_session_lineage lineage
        left join session root on root.id=lineage."rootSessionId" and root."userId"=s."userId" and root."expiresAt">now()
          and root."enterpriseOrganizationId"=s."enterpriseOrganizationId" and root."enterpriseProviderId"=s."enterpriseProviderId"
          and root."enterpriseIdentityId"=s."enterpriseIdentityId"
        where lineage."sessionId"=s.id and (root.id is null or lineage."userId"<>s."userId"
          or lineage."organizationId"::text<>s."enterpriseOrganizationId" or lineage."providerId"<>s."enterpriseProviderId"
          or lineage."identityId"::text<>s."enterpriseIdentityId"))
    limit 1`, [session.session.id, session.user.id])
  // Configuration is mutually exclusive in the DB. Reconfiguration clears
  // session assurance and cannot change protocol while an identity is bound.
  return rows[0] ?? null
}
