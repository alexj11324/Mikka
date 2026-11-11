import 'server-only'
import { pool } from '../db'
import { armDueTimerSoon } from '../due-timer'
import { enqueueIdentityAudit } from './audit-outbox'
import { inheritSamlSession, lockHandoffRoot } from './saml-session-lineage'

/** A new native session can inherit the source's verified SSO identity, never
 * a role, workspace membership or session-bound break-glass permission.
 * Both session identities and every assurance field come from the Auth DB. */
export async function inheritEnterpriseSession(sourceSessionId: string, targetSessionId: string, userId: string): Promise<boolean> {
  const tx = await pool.connect()
  let admitted = false, audited = false
  try {
    await tx.query('begin')
    await tx.query("set local lock_timeout='5s'; set local statement_timeout='10s'")
    const root = await lockHandoffRoot(tx, sourceSessionId, userId)
    if (!root) { await tx.query('rollback'); return false }
    const result = await tx.query<{ id: string; organizationId: string | null; providerId: string | null; identityId: string | null; saml: boolean }>(`with source as materialized (
      select s.* from session s where s.id=$1 and s."userId"=$3 and s."expiresAt">now() for share
    ), proof as (
      select p."organizationScopeId"::text as organization, p."providerId" as provider,
        i.id::text as identity, i."directoryUserId"::text as directory, p."samlConfig" is not null as saml
      from source s join enterprise_identity i on i.id::text=s."enterpriseIdentityId" and i."userId"=s."userId"
        join enterprise_sso_provider p on p."providerId"=i."providerId" and p."providerId"=s."enterpriseProviderId"
      where p."organizationScopeId"::text=s."enterpriseOrganizationId" and p."domainVerified"
        and not exists(select 1 from enterprise_org_policy x where x."organizationId"=p."organizationScopeId" and x."archivedAt" is not null)
        and not exists(select 1 from enterprise_scim_user u join enterprise_scim_connection c on c.id=u."connectionId"
          join enterprise_sso_provider managed on managed."providerId"=c."providerId"
          where u."organizationId"=p."organizationScopeId" and u."userId"=s."userId"
            and (not u.active or u.deleted or c."revokedAt" is not null or not managed."domainVerified"))
        and (i."directoryUserId" is null or exists(select 1 from enterprise_scim_user u
          join enterprise_scim_connection c on c.id=u."connectionId"
          where u.id=i."directoryUserId" and u."userId"=s."userId" and u."organizationId"=p."organizationScopeId"
            and c."providerId"=p."providerId" and u.active and not u.deleted and c."revokedAt" is null))
    ) update session target set ("enterpriseOrganizationId","enterpriseProviderId","enterpriseIdentityId","enterpriseDirectoryUserId") =
      (select organization,provider,identity,directory from proof)
    from source where target.id=$2 and target."userId"=$3 and target.id<>source.id and target."expiresAt">now()
    returning target.id, target."enterpriseOrganizationId" as "organizationId", target."enterpriseProviderId" as "providerId",
      target."enterpriseIdentityId" as "identityId", (select saml from proof) as saml`, [sourceSessionId, targetSessionId, userId])
    const row = result.rows[0]
    if (row?.organizationId && row.providerId) {
      if (row.saml && row.identityId) await inheritSamlSession(tx, { sourceSessionId, targetSessionId, userId,
        organizationId: row.organizationId, providerId: row.providerId, identityId: row.identityId, root })
      await enqueueIdentityAudit(tx, { organizationId: row.organizationId, actorId: userId, action: 'sso.signed_in', targetId: targetSessionId,
        metadata: { providerId: row.providerId, reason: 'web_handoff' } })
      audited = true
    }
    await tx.query('commit')
    admitted = result.rowCount === 1
  } catch (error) { await tx.query('rollback'); throw error } finally { tx.release() }
  if (audited) armDueTimerSoon('audit-retention')
  // A source revoked between the native lookup and creation publishes no new
  // bearer. Ordinary or no-longer-assured sources keep only ordinary authority.
  return admitted
}
