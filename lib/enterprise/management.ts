import 'server-only'
import { X509Certificate, randomBytes, randomUUID } from 'node:crypto'
import { resolveTxt } from 'node:dns/promises'
import { z } from 'zod'
import { eq, sql } from 'drizzle-orm'
import type { PoolClient } from 'pg'
import { deriveSAMLIdentityProviderEntityID, type SAMLConfig } from '@better-auth/sso'
import { isPublicRoutableHost } from '@better-auth/core/utils/host'
import { pool } from '@/lib/db'
import { organizationEntitlements } from '@/lib/db/governance-schema'
import { workspaceDb } from '@/lib/workspace-db'
import { requireOrganizationAdmin } from '@/lib/governance/organizations'
import { resolveEntitlements } from '@/lib/governance/policy'
import { deploymentMode } from '@/lib/governance/edition'
import { GovernanceError } from '@/lib/governance/errors'
import type { WorkspaceTransaction } from '@/lib/workspace-access'
import type { OrganizationAuditInput } from '@/lib/governance/audit-events'
import { withBasePath } from '@/lib/base-path'
import { decryptSsoConfig, encryptSsoConfig } from './sso-plugin'
import { requireEnterpriseOrganization } from './access'
import { identityTokenHash, ScimStore } from './scim-store'
import { retryEnterpriseRevocations, synchronizeDirectoryUser, auditDirectoryGroup } from './lifecycle'
import { commitIdentityChange, enqueueIdentityAudit, deliverIdentityAudits } from './audit-outbox'
import { samlSpMetadata, samlSpSigningInput } from './saml-signing'
import { discoverEnterpriseOidcConfig } from './oidc-config'
import { lockOrganizationLiveAuthority, revokeOrganizationLiveCapabilities } from './live-store'
import { drainOrganizationLiveRevocations } from './live-authority'

const publicHttps = z.url().max(2048).refine(value => {
  const url = new URL(value)
  return url.protocol === 'https:' && !url.username && !url.password && !url.hash && isPublicRoutableHost(url.hostname)
})
const providerId = z.string().regex(/^enterprise-[a-z0-9][a-z0-9-]{1,100}$/)
const domain = z.string().toLowerCase().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/)
const certificate = z.string().max(12000).refine(value => {
  try { const cert = new X509Certificate(value); return Date.parse(cert.validTo) > Date.now() && Date.parse(cert.validFrom) <= Date.now() }
  catch { return false }
})
const configureInput = z.discriminatedUnion('protocol', [
  z.object({ action: z.literal('configure-provider'), providerId, domain, protocol: z.literal('oidc'),
    issuer: publicHttps, clientId: z.string().min(1).max(512), clientSecret: z.string().min(1).max(4096),
    tokenEndpointAuthentication: z.enum(['client_secret_basic', 'client_secret_post']).default('client_secret_basic'),
  }).strict(),
  z.object({ action: z.literal('configure-provider'), providerId, domain, protocol: z.literal('saml'),
    issuer: z.string().min(1).max(2048), idpEntityId: z.string().min(1).max(2048), entryPoint: publicHttps,
    cert: z.union([certificate, z.array(certificate).min(1).max(3)]), logoutEntryPoint: publicHttps.optional(), logoutPostEntryPoint: publicHttps.optional(),
    spSigning: samlSpSigningInput.optional(),
    mapping: z.object({ email: z.string().min(1).max(512), name: z.string().min(1).max(512).optional() }).optional(),
  }).strict(),
])
const actionInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('verify-domain'), providerId, token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(),
  z.object({ action: z.literal('rotate-scim'), providerId }).strict(),
  z.object({ action: z.literal('revoke-scim'), connectionId: z.uuid() }).strict(),
  z.object({ action: z.literal('disable-provider'), providerId }).strict(),
  z.object({ action: z.literal('policy'), enforceSso: z.boolean(), allowMachineCredentials: z.boolean() }).strict(),
  z.object({ action: z.literal('break-glass'), reason: z.string().trim().min(10).max(500) }).strict(),
  z.object({ action: z.literal('retry-revocations') }).strict(),
])

async function administratorInTransaction(tx: WorkspaceTransaction, organizationId: string, userId: string, licensed: boolean) {
  const result = await requireOrganizationAdmin(tx, organizationId, userId)
  if (licensed) {
    const [grant] = await tx.select().from(organizationEntitlements).where(eq(organizationEntitlements.organizationId, organizationId))
    if (resolveEntitlements({ mode: deploymentMode(), kind: 'team', grant }).plan !== 'enterprise') throw new GovernanceError('feature_unavailable')
  }
  return result
}
async function administrator(organizationId: string, userId: string, licensed: boolean) {
  return workspaceDb.transaction(tx => administratorInTransaction(tx, organizationId, userId, licensed))
}

export async function identitySummary(organizationId: string, userId: string) {
  await administrator(organizationId, userId, false)
  await retryEnterpriseRevocations(organizationId)
  await deliverIdentityAudits(organizationId)
  const { rows: providers } = await pool.query(`select "providerId",domain,"domainVerified",case when "oidcConfig" is null then 'saml' else 'oidc' end as protocol,"createdAt","updatedAt"
    from enterprise_sso_provider where "organizationScopeId"=$1 order by "createdAt"`, [organizationId])
  const { rows: connections } = await pool.query('select id,"providerId","revokedAt","createdAt" from enterprise_scim_connection where "organizationId"=$1', [organizationId])
  const { rows: policies } = await pool.query('select "enforceSso","allowMachineCredentials" from enterprise_org_policy where "organizationId"=$1', [organizationId])
  return { providers, connections, policy: policies[0] ?? { enforceSso: false, allowMachineCredentials: false } }
}

export async function manageIdentity(organizationId: string, session: { user: { id: string }; session: { id: string } }, input: unknown, origin: string) {
  z.uuid().parse(organizationId)
  const actorId = session.user.id
  const action = z.object({ action: z.string() }).parse(input).action
  const recovery = ['break-glass', 'retry-revocations', 'disable-provider', 'revoke-scim'].includes(action)
    || action === 'policy' && (() => { const value = actionInput.parse(input); return value.action === 'policy' && !value.enforceSso && !value.allowMachineCredentials })()
  const admin = await administrator(organizationId, actorId, !recovery)
  if (action !== 'break-glass') await requireEnterpriseOrganization(actorId, organizationId, session.session.id)
  // Network discovery/proof happens before this short lease. Final authorization
  // remains locked through the Auth DB commit; delivery starts after its release.
  const mutate = async <T>(work: () => Promise<T>) => {
    const result = await workspaceDb.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout='5s'; set local statement_timeout='10s'`)
      const current = await administratorInTransaction(tx, organizationId, actorId, !recovery)
      if (action === 'break-glass' && current.membership.role !== 'owner') throw new GovernanceError('access_denied')
      if (action !== 'break-glass') await requireEnterpriseOrganization(actorId, organizationId, session.session.id)
      return work()
    })
    if (['configure-provider', 'disable-provider', 'policy', 'revoke-scim'].includes(action)) await drainOrganizationLiveRevocations(organizationId)
    await deliverIdentityAudits(organizationId)
    return result
  }
  const commit = <T>(audit: OrganizationAuditInput, work: (tx: PoolClient) => Promise<T>) =>
    mutate(() => commitIdentityChange(audit, async tx => {
      const changesAuthority = ['configure-provider', 'disable-provider', 'policy'].includes(action)
      // Org -> session rows/triggers -> remaining cap rows. Native DELETE
      // already owns its session row before its trigger; taking cap rows
      // first would deadlock a simultaneous provider reset and sign-out.
      if (changesAuthority) await lockOrganizationLiveAuthority(tx, organizationId)
      const result = await work(tx)
      if (changesAuthority) await revokeOrganizationLiveCapabilities(tx, organizationId)
      return result
    }, { deferDelivery: true }))
  if (action === 'configure-provider') {
    const value = configureInput.parse(input)
    const { rows: bound } = await pool.query('select "organizationScopeId",issuer,"samlConfig","oidcConfig" from enterprise_sso_provider where "providerId"=$1', [value.providerId])
    if (bound[0] && bound[0].organizationScopeId !== organizationId) throw new GovernanceError('access_denied')
    if (bound[0]) {
      const beforeAuthority = bound[0].samlConfig
        ? deriveSAMLIdentityProviderEntityID(JSON.parse(decryptSsoConfig(bound[0].samlConfig, 'samlConfig')) as SAMLConfig) : bound[0].issuer
      const nextAuthority = value.protocol === 'saml' ? value.idpEntityId : value.issuer
      if (beforeAuthority !== nextAuthority || Boolean(bound[0].samlConfig) !== (value.protocol === 'saml')) {
        const { rows } = await pool.query(`select 1 from enterprise_identity where "providerId"=$1
          union all select 1 from enterprise_scim_user u join enterprise_scim_connection c on c.id=u."connectionId" where c."providerId"=$1 limit 1`, [value.providerId])
        if (rows.length) throw new GovernanceError('invalid_request')
      }
    }
    let oidc: string | null = null
    let saml: string | null = null
    if (value.protocol === 'oidc') {
      const hydrated = await discoverEnterpriseOidcConfig(value.issuer, value.tokenEndpointAuthentication)
      for (const endpoint of [hydrated.authorizationEndpoint, hydrated.tokenEndpoint, hydrated.jwksEndpoint, hydrated.discoveryEndpoint, hydrated.userInfoEndpoint, hydrated.endSessionEndpoint].filter(Boolean)) publicHttps.parse(endpoint)
      oidc = encryptSsoConfig({ ...hydrated, pkce: true, clientId: value.clientId, clientSecret: value.clientSecret,
        scopes: ['openid', 'email', 'profile'], allowIdpInitiated: false }, 'oidcConfig')
    } else {
      const config: SAMLConfig = { issuer: value.issuer, audience: value.issuer, entryPoint: value.entryPoint, cert: value.cert,
        idpMetadata: { entityID: value.idpEntityId, cert: value.cert, singleSignOnService: [{ Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect', Location: value.entryPoint }],
          ...(value.logoutEntryPoint || value.logoutPostEntryPoint ? { singleLogoutService: [
            ...(value.logoutEntryPoint ? [{ Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect', Location: value.logoutEntryPoint }] : []),
            ...(value.logoutPostEntryPoint ? [{ Binding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST', Location: value.logoutPostEntryPoint }] : []),
          ] } : {}) },
        wantAssertionsSigned: true, authnRequestsSigned: !!value.spSigning, mapping: value.mapping,
        ...(value.spSigning ? { spMetadata: { metadata: samlSpMetadata({ issuer: value.issuer, signing: value.spSigning,
          acsUrl: `${origin}${withBasePath(`/api/auth/sso/saml2/sp/acs/${value.providerId}`)}`,
          sloUrl: `${origin}${withBasePath(`/api/auth/sso/saml2/sp/slo/${value.providerId}`)}` }),
          privateKey: value.spSigning.privateKey, privateKeyPass: value.spSigning.passphrase } } : {}),
      }
      deriveSAMLIdentityProviderEntityID(config)
      saml = encryptSsoConfig(config, 'samlConfig')
    }
    const token = randomBytes(32).toString('base64url')
    // Replacing authentication configuration invalidates old assurance and requires new DNS proof.
    await commit({ organizationId, actorId, action: 'sso.configured', targetId: value.providerId, metadata: { providerId: value.providerId } }, async tx => {
      await tx.query(`insert into enterprise_sso_provider (id,"providerId","organizationScopeId","userId",issuer,domain,"oidcConfig","samlConfig","domainTokenHash")
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict ("providerId") do update set issuer=excluded.issuer,domain=excluded.domain,
        "oidcConfig"=excluded."oidcConfig","samlConfig"=excluded."samlConfig","domainTokenHash"=excluded."domainTokenHash",
        "domainVerified"=false,"updatedAt"=now()
        where enterprise_sso_provider."organizationScopeId"=excluded."organizationScopeId"`,
      [randomUUID(), value.providerId, organizationId, actorId, value.issuer, value.domain, oidc, saml, identityTokenHash(token)])
      await tx.query('update session set "enterpriseOrganizationId"=null,"enterpriseProviderId"=null,"enterpriseDirectoryUserId"=null,"enterpriseIdentityId"=null where "enterpriseProviderId"=$1', [value.providerId])
    })
    return { providerId: value.providerId, dns: { type: 'TXT', name: `_mikka-sso.${value.domain}`, value: `mikka-sso=${token}`, token },
      callbackURL: `${origin}${withBasePath(`/api/auth/${value.protocol === 'oidc' ? 'sso/callback' : 'sso/saml2/sp/acs'}/${value.providerId}`)}`,
      ...(value.protocol === 'oidc' ? { postLogoutRedirectURI: `${origin}${withBasePath(`/api/auth/sso/oidc/logout/callback/${value.providerId}`)}` } : {}) }
  }
  const value = actionInput.parse(input)
  if (value.action === 'verify-domain') {
    const { rows } = await pool.query<{ domain: string; domainTokenHash: string }>('select domain,"domainTokenHash" from enterprise_sso_provider where "providerId"=$1 and "organizationScopeId"=$2', [value.providerId, organizationId])
    if (!rows[0] || identityTokenHash(value.token) !== rows[0].domainTokenHash) throw new GovernanceError('invalid_request')
    const records = await resolveTxt(`_mikka-sso.${rows[0].domain}`)
    if (!records.some(parts => parts.join('') === `mikka-sso=${value.token}`)) throw new GovernanceError('invalid_request')
    await commit({ organizationId, actorId, action: 'sso.domain_verified', targetId: value.providerId, metadata: { providerId: value.providerId } }, async tx => {
      const verified = await tx.query(`update enterprise_sso_provider set "domainVerified"=true,"updatedAt"=now()
        where "providerId"=$1 and "organizationScopeId"=$2 and "domainTokenHash"=$3
        and not exists(select 1 from enterprise_org_policy where "organizationId"=$2 and "archivedAt" is not null)`, [value.providerId, organizationId, identityTokenHash(value.token)])
      if (!verified.rowCount) throw new GovernanceError('invalid_request')
    })
    return { verified: true }
  }
  if (value.action === 'rotate-scim') {
    const { rows } = await pool.query('select id from enterprise_sso_provider where "providerId"=$1 and "organizationScopeId"=$2 and "domainVerified"', [value.providerId, organizationId])
    if (!rows.length) throw new GovernanceError('invalid_request')
    const token = `msc_${randomBytes(32).toString('base64url')}`
    const { rows: connections } = await commit({ organizationId, actorId, action: 'sso.configured', targetId: value.providerId,
      metadata: { providerId: value.providerId, reason: 'scim_credential_rotated' } }, tx => tx.query<{ id: string }>(`insert into enterprise_scim_connection (id,"organizationId","providerId","tokenHash") values ($1,$2,$3,$4)
      on conflict ("organizationId","providerId") do update set "tokenHash"=excluded."tokenHash","revokedAt"=null returning id`, [randomUUID(), organizationId, value.providerId, identityTokenHash(token)]))
    return { id: connections[0].id, token, baseURL: `${origin}${withBasePath(`/api/scim/v2/${connections[0].id}`)}` }
  }
  if (value.action === 'revoke-scim') {
    const store = new ScimStore(pool, synchronizeDirectoryUser, auditDirectoryGroup)
    const connection = await mutate(() => store.revokeConnection(organizationId, value.connectionId, tx => enqueueIdentityAudit(tx,
      { organizationId, actorId, action: 'sso.configured', targetId: value.connectionId, metadata: { reason: 'scim_credential_revoked' } }), { deferDelivery: true }))
    await store.drain(connection)
    return { revoked: true }
  }
  if (value.action === 'disable-provider') {
    await commit({ organizationId, actorId, action: 'sso.policy_changed', targetId: value.providerId, metadata: { reason: 'provider_disabled', enabled: false } }, async tx => {
      const disabled = await tx.query('update enterprise_sso_provider set "domainVerified"=false,"updatedAt"=now() where "providerId"=$1 and "organizationScopeId"=$2', [value.providerId, organizationId])
      if (!disabled.rowCount) throw new GovernanceError('not_found')
      await tx.query('update session set "enterpriseOrganizationId"=null,"enterpriseProviderId"=null,"enterpriseDirectoryUserId"=null,"enterpriseIdentityId"=null where "enterpriseProviderId"=$1', [value.providerId])
    })
    const { rows } = await pool.query<{ id: string }>('select id from enterprise_scim_connection where "providerId"=$1 and "organizationId"=$2', [value.providerId, organizationId])
    const store = new ScimStore(pool, synchronizeDirectoryUser, auditDirectoryGroup)
    const revocations = await Promise.allSettled(rows.map(connection => store.revokeConnection(organizationId, connection.id)))
    const failed = revocations.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
    return { disabled: true }
  }
  if (value.action === 'policy') {
    if (value.enforceSso) {
      const { rows } = await pool.query(`select s.id from session s join enterprise_identity i on i.id::text=s."enterpriseIdentityId"
        join enterprise_sso_provider p on p."providerId"=i."providerId" where s.id=$1 and s."userId"=$2 and i."userId"=$2 and s."enterpriseOrganizationId"=$3
        and s."expiresAt">now() and p."domainVerified"
        and not exists(select 1 from enterprise_scim_user u where u."organizationId"=$3::uuid and u."userId"=$2 and (not u.active or u.deleted))`, [session.session.id, actorId, organizationId])
      if (!rows.length) throw new GovernanceError('access_denied')
    }
    await commit({ organizationId, actorId, action: 'sso.policy_changed', targetId: organizationId, metadata: { enabled: value.enforceSso } }, tx =>
      tx.query(`insert into enterprise_org_policy ("organizationId","enforceSso","allowMachineCredentials") values ($1,$2,$3)
        on conflict ("organizationId") do update set "enforceSso"=excluded."enforceSso","allowMachineCredentials"=excluded."allowMachineCredentials","updatedAt"=now()`, [organizationId, value.enforceSso, value.allowMachineCredentials]))
    return { enforceSso: value.enforceSso, allowMachineCredentials: value.allowMachineCredentials }
  }
  if (value.action === 'break-glass') {
    if (admin.membership.role !== 'owner') throw new GovernanceError('access_denied')
    const { rows } = await pool.query('select id from session where id=$1 and "userId"=$2 and "createdAt">now()-interval \'5 minutes\' and "expiresAt">now()', [session.session.id, actorId])
    if (!rows.length) throw new GovernanceError('access_denied')
    const expiresAt = new Date(Date.now() + 15 * 60_000)
    await commit({ organizationId, actorId, action: 'sso.policy_changed', targetId: organizationId, metadata: { reason: 'owner_break_glass', enabled: true } }, tx =>
      tx.query(`insert into enterprise_break_glass ("organizationId","userId","sessionId","expiresAt",reason) values ($1,$2,$3,$4,$5)
        on conflict ("organizationId","sessionId") do update set "expiresAt"=excluded."expiresAt",reason=excluded.reason`, [organizationId, actorId, session.session.id, expiresAt, value.reason]))
    return { expiresAt: expiresAt.toISOString() }
  }
  await retryEnterpriseRevocations(organizationId)
  await drainOrganizationLiveRevocations(organizationId)
  await deliverIdentityAudits(organizationId)
  return { retried: true }
}

/** Must precede an SSO round trip. Only the directory's matching verified email owner can consent. */
export async function startIdentityLink(session: { user: { id: string; email: string; emailVerified?: boolean }; session: { id: string } }, provider: string) {
  providerId.parse(provider)
  const { rows } = await pool.query(`select s.id from session s join "user" u on u.id=s."userId" where s.id=$1 and s."userId"=$2
    and s."createdAt">now()-interval '5 minutes' and s."expiresAt">now() and u."emailVerified"`, [session.session.id, session.user.id])
  if (!rows.length) throw new GovernanceError('access_denied')
  const ticket = randomBytes(32).toString('base64url')
  await pool.query('insert into enterprise_link_ticket (id,"providerId","userId","sessionId","expiresAt") values ($1,$2,$3,$4,now()+interval \'10 minutes\')',
    [identityTokenHash(ticket), provider, session.user.id, session.session.id])
  return ticket
}
