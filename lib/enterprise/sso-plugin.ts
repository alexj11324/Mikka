import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { isAPIError } from '@better-auth/core/utils/is-api-error'
import { sso, type SSOOptions, type SSOUserResolutionInput, type SSOUserResolutionContext } from '@better-auth/sso'
import { APIError, type BetterAuthPlugin, type DBTransactionAdapter } from 'better-auth'
import { createAuthMiddleware, getSessionFromCtx } from 'better-auth/api'
import type { DBFieldAttribute } from 'better-auth/db'
import { openSecret, sealSecret, type Sealed } from '../secrets/crypto'
import { identityTokenHash } from './scim-store'
import { enterpriseOidcLogoutEndpoints } from './oidc-logout'
import type { VerifiedSamlLogout } from './saml-session-lineage'

export type EnterpriseLoginProof = { organizationId: string; providerId: string; directoryUserId: string | null; identityId: string; userId: string }
type Proof = EnterpriseLoginProof
type LogoutProof = { organizationId: string; providerId: string; userId: string; sessionId: string; reason?: string; failed?: boolean; samlRoot?: { rootSessionId: string; identityId: string } }
const context = new AsyncLocalStorage<{ linkTicket?: string; proof?: Proof; logout?: LogoutProof; correlationId: string; auditUnavailable?: boolean }>()
export function withEnterpriseAuthRequest(handler: (request: Request) => Promise<Response>) {
  return (request: Request) => {
    const ticket = /(?:^|;\s*)mikka-sso-link=([A-Za-z0-9_-]{43})(?:;|$)/.exec(request.headers.get('cookie') ?? '')?.[1]
    return context.run({ linkTicket: ticket, correlationId: randomUUID() }, async () => {
      const singleLogout = /\/sso\/saml2\/sp\/slo\/[^/]+$/.test(new URL(request.url).pathname)
      // SAML signatures and the provider/NameID lookup identify the session being closed. A browser's
      // unrelated personal/other-provider cookie must neither select a second session nor be cleared.
      const headers = new Headers(request.headers)
      if (singleLogout) headers.delete('cookie')
      const response = await handler(new Request(request, { headers }))
      // Native redirects may retain their status when an after-hook throws. The outer HTTP boundary
      // is authoritative: never publish a bearer cookie or successful response after an audit failure.
      if (context.getStore()?.auditUnavailable) return Response.json({ code: 'ENTERPRISE_AUDIT_UNAVAILABLE', message: 'Authentication unavailable' }, { status: 503, headers: { 'cache-control': 'no-store' } })
      if (!singleLogout) return response
      const outgoing = new Headers(response.headers)
      outgoing.delete('set-cookie')
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outgoing })
    })
  }
}

export function ssoSessionData(userId: string) {
  const proof = context.getStore()?.proof
  if (!proof || proof.userId !== userId) return {}
  return { enterpriseOrganizationId: proof.organizationId, enterpriseProviderId: proof.providerId, enterpriseDirectoryUserId: proof.directoryUserId, enterpriseIdentityId: proof.identityId }
}
export const enterpriseSessionFields = {
  enterpriseOrganizationId: { type: 'string', required: false, input: false, returned: false },
  enterpriseProviderId: { type: 'string', required: false, input: false, returned: false },
  enterpriseDirectoryUserId: { type: 'string', required: false, input: false, returned: false },
  enterpriseIdentityId: { type: 'string', required: false, input: false, returned: false },
} as const

type Provider = { providerId: string; organizationScopeId: string; domainVerified: boolean; domain: string }
type Directory = { id: string; userId: string | null; userName: string; organizationId: string }
type Connection = { id: string; organizationId: string }
type LinkTicket = { userId: string; sessionId: string }
type Identity = { id: string; userId: string; directoryUserId: string | null }

async function consentedAccount(database: DBTransactionAdapter, providerId: string, email: string): Promise<string | null> {
  const ticketValue = context.getStore()?.linkTicket
  if (!ticketValue) return null
  const ticket = await database.consumeOne<LinkTicket>({ model: 'enterpriseLinkTicket', where: [
    { field: 'id', value: identityTokenHash(ticketValue) }, { field: 'providerId', value: providerId }, { field: 'expiresAt', operator: 'gt', value: new Date() },
  ] })
  if (!ticket) return null
  const session = await database.findOne<{ id: string }>({ model: 'session', where: [{ field: 'id', value: ticket.sessionId }, { field: 'userId', value: ticket.userId }, { field: 'expiresAt', operator: 'gt', value: new Date() }] })
  const user = await database.findOne<{ email: string; emailVerified: boolean }>({ model: 'user', where: [{ field: 'id', value: ticket.userId }] })
  return session && user?.emailVerified && user.email.toLowerCase() === email.toLowerCase() ? ticket.userId : null
}

/** The callback only sees cryptographically verified issuer/subject, never email-derived identity. */
export async function resolveEnterpriseIdentity(input: SSOUserResolutionInput, { database }: SSOUserResolutionContext) {
  const request = context.getStore()
  if (!request) return { action: 'reject' as const, code: 'ENTERPRISE_AUTH_CONTEXT_REQUIRED' }
  const provider = await database.findOne<Provider>({ model: 'ssoProvider', where: [{ field: 'providerId', value: input.providerId }] })
  if (!provider?.domainVerified || !provider.organizationScopeId) return { action: 'reject' as const, code: 'ENTERPRISE_PROVIDER_UNVERIFIED' }
  const email = input.providerUser.email.toLowerCase()
  if (email.split('@')[1] !== provider.domain) return { action: 'reject' as const, code: 'ENTERPRISE_EMAIL_DOMAIN_MISMATCH' }
  const where = [{ field: 'providerId', value: input.providerId }, { field: 'issuer', value: input.accountKey.issuer }, { field: 'subject', value: input.accountKey.accountId }]
  let identity = await database.findOne<Identity>({ model: 'enterpriseIdentity', where })
  const connection = await database.incrementOne<Connection>({ model: 'enterpriseScimConnection', where: [
    { field: 'providerId', value: input.providerId }, { field: 'organizationId', value: provider.organizationScopeId }, { field: 'revokedAt', value: null },
  ], increment: { fence: 1 } })
  let userId: string | null = identity?.userId ?? null
  let directory: Directory | null = null
  if (connection) {
    directory = await database.incrementOne<Directory>({ model: 'enterpriseScimUser', where: [
    { field: 'connectionId', value: connection.id }, { field: 'externalId', value: input.accountKey.accountId },
    { field: 'active', value: true }, { field: 'deleted', value: false },
  ], increment: { fence: 1 } })
    if (!directory) return { action: 'reject' as const, code: 'ENTERPRISE_DIRECTORY_INACTIVE' }
    if (!directory.userId) {
      // An existing signed issuer/subject binding may be adopted when SCIM is enabled later.
      const linked = identity?.userId ?? await consentedAccount(database, input.providerId, directory.userName)
      if (!linked) return { action: 'reject' as const, code: 'ENTERPRISE_ACCOUNT_LINK_REQUIRED' }
      await database.update({ model: 'enterpriseScimUser', where: [{ field: 'id', value: directory.id }], update: { userId: linked } })
      directory.userId = linked
    }
    userId = directory.userId
  } else {
    const managed = await database.findOne<{ id: string }>({ model: 'enterpriseScimConnection', where: [{ field: 'providerId', value: input.providerId }] })
    if (managed) return { action: 'reject' as const, code: 'ENTERPRISE_DIRECTORY_REVOKED' }
    if (!userId) {
      const existing = await database.findOne<{ id: string }>({ model: 'user', where: [{ field: 'email', value: email }] })
      if (existing) userId = await consentedAccount(database, input.providerId, email)
      else {
        const user = await database.create<Record<string, unknown>, { id: string }>({ model: 'user', forceAllowId: true,
          data: { id: randomUUID(), email, name: input.providerUser.name || email, emailVerified: input.providerUser.emailVerified, createdAt: new Date(), updatedAt: new Date() } })
        userId = user.id
      }
      if (!userId) return { action: 'reject' as const, code: 'ENTERPRISE_ACCOUNT_LINK_REQUIRED' }
    }
  }
  if (identity && (identity.userId !== userId || (identity.directoryUserId && identity.directoryUserId !== directory?.id)))
    return { action: 'reject' as const, code: 'ENTERPRISE_IDENTITY_CONFLICT' }
  if (!identity) identity = await database.create<Record<string, unknown>, Identity>({ model: 'enterpriseIdentity', forceAllowId: true, data: {
    id: randomUUID(), providerId: input.providerId, issuer: input.accountKey.issuer, subject: input.accountKey.accountId,
    directoryUserId: directory?.id ?? null, userId,
  } })
  else if (directory && !identity.directoryUserId) await database.update({ model: 'enterpriseIdentity', where: [{ field: 'id', value: identity.id }], update: { directoryUserId: directory.id } })
  request.proof = { organizationId: provider.organizationScopeId, providerId: input.providerId, directoryUserId: directory?.id ?? null, identityId: identity.id, userId }
  return { action: 'link' as const, userId, profile: 'preserve' as const }
}

type EnterpriseAuthenticationContext = {
  path?: string
  params?: { providerId?: string }
  context: {
    newSession?: { user: { id: string }; session: { id: string; token: string } } | null
    session?: { user: { id: string }; session: { id: string; enterpriseOrganizationId?: unknown; enterpriseProviderId?: unknown } } | null
    responseHeaders?: Headers
    returned?: unknown
    internalAdapter: { deleteSession(token: string): Promise<unknown> }
  }
}

/** Runs before Better Auth publishes its result; an unaudited SSO success never returns a bearer cookie. */
export async function completeEnterpriseSignIn(ctx: EnterpriseAuthenticationContext) {
  try { await finishEnterpriseAuthentication(ctx) }
  catch (error) {
    const request = context.getStore()
    if (request) request.auditUnavailable = true
    const { auditFailureSummary } = await import('../audit/record')
    console.error('[enterprise] authentication intent unavailable', auditFailureSummary(error))
    // error-cause: retain safe SQLSTATE/constraint diagnostics above; native auth errors must not carry query parameters or bearer values.
    throw new APIError('SERVICE_UNAVAILABLE', { code: 'ENTERPRISE_AUDIT_UNAVAILABLE', message: 'Authentication unavailable' })
  }
}

async function finishEnterpriseAuthentication(ctx: EnterpriseAuthenticationContext) {
  const request = context.getStore()
  if (!request) return
  const proof = request.proof, session = ctx.context.newSession
  if (proof && session?.user.id === proof.userId) {
    try {
      if (ctx.path === '/sso/saml2/sp/acs/:providerId')
        await (await import('./saml-session-lineage')).registerSamlSession({ ...proof, sessionId: session.session.id })
      await (await import('./lifecycle')).synchronizeEnterpriseLogin(proof, { sessionId: session.session.id, correlationId: request.correlationId })
    } catch (error) {
      ctx.context.responseHeaders?.delete('set-cookie')
      ctx.context.newSession = null
      try { await ctx.context.internalAdapter.deleteSession(session.session.token) } catch { /* Withhold the bearer even if a database outage prevents cleanup. */ }
      throw error // The outer handler records safe cause fields and withholds the HTTP result.
    }
    return
  }
  // Better Auth supplies the route template in path and the actual value in params.
  const providerId = ['/sso/callback/:providerId', '/sso/saml2/sp/acs/:providerId'].includes(ctx.path ?? '') ? ctx.params?.providerId : undefined
  if (providerId && !session) {
    const [{ pool }, { workspaceDb }, { enqueueOrganizationAudit }] = await Promise.all([import('../db'), import('../workspace-db'), import('../governance/audit')])
    const { rows: [provider] } = await pool.query<{ organizationId: string }>('select "organizationScopeId" as "organizationId" from enterprise_sso_provider where "providerId"=$1', [providerId])
    if (provider) await workspaceDb.transaction(tx => enqueueOrganizationAudit(tx, { organizationId: provider.organizationId, actorId: 'system', action: 'sso.sign_in_failed',
      targetId: providerId, result: 'denied', correlationId: request.correlationId, metadata: { providerId, reason: 'invalid' } }))
  }
  const previous = request.logout
  if (previous) {
    // Only a completed native SP redirect may revoke the initiating child's root.
    if (previous.samlRoot && ctx.path === '/sso/saml2/logout/:providerId'
      && isAPIError(ctx.context.returned) && ctx.context.returned.statusCode === 302)
      await (await import('./saml-session-lineage')).finishDerivedSamlLogout({ ...previous, ...previous.samlRoot })
    const [{ workspaceDb }, { enqueueOrganizationAudit }] = await Promise.all([import('../workspace-db'), import('../governance/audit')])
    const denied = previous.failed || (isAPIError(ctx.context.returned) && ctx.context.returned.statusCode >= 400)
    await workspaceDb.transaction(tx => enqueueOrganizationAudit(tx, { organizationId: previous.organizationId, actorId: previous.userId,
      action: denied ? 'sso.logout_failed' : 'sso.signed_out', targetId: previous.sessionId, result: previous.failed ? 'failure' : denied ? 'denied' : 'success', correlationId: request.correlationId,
      metadata: { providerId: previous.providerId, ...(previous.reason ? { reason: previous.reason } : {}) } }))
  }
  const logoutProvider = ctx.path === '/sso/saml2/sp/slo/:providerId' ? ctx.params?.providerId : undefined
  if (logoutProvider) {
    const [{ pool }, { workspaceDb }, { enqueueOrganizationAudit }] = await Promise.all([import('../db'), import('../workspace-db'), import('../governance/audit')])
    const { rows: [provider] } = await pool.query<{ organizationId: string }>('select "organizationScopeId" as "organizationId" from enterprise_sso_provider where "providerId"=$1', [logoutProvider])
    const denied = isAPIError(ctx.context.returned) && ctx.context.returned.statusCode >= 400
    if (provider) await workspaceDb.transaction(tx => enqueueOrganizationAudit(tx, { organizationId: provider.organizationId, actorId: `saml:${logoutProvider}`,
      action: denied ? 'sso.logout_failed' : 'sso.signed_out', targetId: logoutProvider, result: denied ? 'denied' : 'success',
      correlationId: request.correlationId, metadata: { providerId: logoutProvider, reason: denied ? 'invalid' : 'single_logout' } }))
  }
}

export const configAAD = (field: 'oidcConfig' | 'samlConfig') => `mikka:enterprise-sso:${field}:v1`
export function encryptSsoConfig(value: unknown, field: 'oidcConfig' | 'samlConfig') {
  return JSON.stringify(sealSecret(typeof value === 'string' ? value : JSON.stringify(value), configAAD(field)))
}
export function decryptSsoConfig(value: string, field: 'oidcConfig' | 'samlConfig') {
  return openSecret(JSON.parse(value) as Sealed, configAAD(field))
}

/** Management is app-owned; native endpoints handle OIDC/SAML signatures, state, PKCE, replay and SLO. */
export function enterpriseSso(options: Pick<SSOOptions, 'defaultSSO'> = {}) {
  // Explicit extension in the pinned package patch: native-verified requests only.
  const saml: NonNullable<SSOOptions['saml']> & { onVerifiedLogoutRequest(input: VerifiedSamlLogout): Promise<true> } = {
    enableInResponseToValidation: true, allowIdpInitiated: false, enableSingleLogout: true, wantLogoutRequestSigned: true, wantLogoutResponseSigned: true,
    onVerifiedLogoutRequest: async input => {
      try { return await (await import('./saml-session-lineage')).revokeVerifiedSamlSessions(input) }
      catch (error) {
        const request = context.getStore(); if (request) request.auditUnavailable = true
        const { auditFailureSummary } = await import('../audit/record')
        console.error('[enterprise] SAML logout unavailable', auditFailureSummary(error))
        // error-cause: preserve safe cause classification; never pass SQL/protocol data into native auth errors.
        throw new APIError('SERVICE_UNAVAILABLE', { code: 'ENTERPRISE_LOGOUT_UNAVAILABLE', message: 'Logout unavailable' })
      }
    },
  }
  const plugin = sso({ ...options, modelName: 'enterprise_sso_provider', providersLimit: 0,
    organizationProvisioning: { disabled: true }, domainVerification: { enabled: true },
    trustEmailVerified: true, resolveUser: resolveEnterpriseIdentity,
    saml,
    schema: { ssoProvider: { additionalFields: { organizationScopeId: { type: 'string', required: true, input: false, returned: false } } } },
  })
  for (const field of ['oidcConfig', 'samlConfig'] as const) {
    const definition = plugin.schema.ssoProvider.fields[field] as DBFieldAttribute
    definition.transform = { input: value => value == null ? value : encryptSsoConfig(value, field), output: value => value == null ? value : decryptSsoConfig(String(value), field) }
  }
  const nativeHooks = (plugin as BetterAuthPlugin).hooks
  const logoutHook = {
    matcher: (ctx: { path?: string }) => ctx.path === '/sign-out' || ctx.path === '/sso/saml2/logout/:providerId',
    handler: createAuthMiddleware(async ctx => {
      const request = context.getStore()
      if (!request) return
      const session = await getSessionFromCtx(ctx)
      if (!session) return
      // returned:false keeps assurance out of public sessions; read its trusted value before deletion.
      const { pool } = await import('../db')
      const { rows: [proof] } = await pool.query<LogoutProof>(`select "enterpriseOrganizationId" as "organizationId", "enterpriseProviderId" as "providerId", "userId", id as "sessionId"
        from session where id=$1 and "userId"=$2 and "expiresAt">now() and "enterpriseOrganizationId" is not null and "enterpriseProviderId" is not null`, [session.session.id, session.user.id])
      if (ctx.path === '/sso/saml2/logout/:providerId' && proof?.providerId !== ctx.params?.providerId)
        throw new APIError('FORBIDDEN', { code: 'ENTERPRISE_LOGOUT_SESSION_MISMATCH', message: 'Invalid logout session' })
      if (ctx.path === '/sso/saml2/logout/:providerId' && proof)
        proof.samlRoot = await (await import('./saml-session-lineage')).derivedSamlRoot(proof.sessionId, proof.userId, proof.organizationId, proof.providerId)
      request.logout = proof
    }),
  }
  const oidcLogout = enterpriseOidcLogoutEndpoints({ decryptConfig: value => decryptSsoConfig(value, 'oidcConfig'),
    record: (proof, reason, failed) => { const request = context.getStore(); if (request) request.logout = { ...proof, reason, failed } },
  })
  return { ...plugin, endpoints: { ...plugin.endpoints, ...oidcLogout }, hooks: { ...nativeHooks, before: [logoutHook, ...(nativeHooks?.before ?? [])] } }
}

const string = { type: 'string', required: true } as const
const optionalString = { type: 'string', required: false } as const
/** Extra adapter models allow the resolver fence and account/session creation to share one native transaction. */
export const enterpriseIdentityModels = {
  id: 'mikka-enterprise-identity',
  schema: {
    enterpriseScimConnection: { modelName: 'enterprise_scim_connection', fields: { organizationId: string, providerId: string, revokedAt: { type: 'date', required: false }, fence: { type: 'number', defaultValue: 0 } } },
    enterpriseScimUser: { modelName: 'enterprise_scim_user', fields: { connectionId: string, organizationId: string, externalId: string, userName: string, userId: optionalString,
      active: { type: 'boolean', required: true }, deleted: { type: 'boolean', required: true }, fence: { type: 'number', defaultValue: 0 } } },
    enterpriseIdentity: { modelName: 'enterprise_identity', fields: { providerId: string, issuer: string, subject: string, directoryUserId: optionalString, userId: string } },
    enterpriseLinkTicket: { modelName: 'enterprise_link_ticket', fields: { providerId: string, userId: string, sessionId: string, expiresAt: { type: 'date', required: true } } },
  },
} satisfies BetterAuthPlugin
