import 'server-only'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { APIError } from 'better-auth'
import { createAuthEndpoint, getSessionFromCtx } from 'better-auth/api'
import { deleteSessionCookie } from 'better-auth/cookies'
import { pool } from '../db'
import { withBasePath } from '../base-path'
import { identityTokenHash } from './scim-store'

export type OidcLogoutProof = { organizationId: string; providerId: string; userId: string; sessionId: string }
type LogoutReason = 'oidc_local_failed' | 'oidc_local_only' | 'oidc_provider_unavailable' | 'oidc_upstream_requested' | 'oidc_upstream_returned' | 'oidc_upstream_failed'
const lifetimeSeconds = 5 * 60
const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const provider = z.string().regex(/^enterprise-[a-z0-9][a-z0-9-]{1,100}$/)
const bindingSchema = z.object({
  version: z.literal(1), organizationId: z.uuid(), providerId: provider,
  userId: z.string().min(1).max(200), sessionId: z.string().min(1).max(200),
  issuer: z.url(), clientId: z.string().min(1).max(512), redirectUri: z.url(),
  browserHash: z.string().regex(/^[a-f0-9]{64}$/), configurationHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
type ProviderRow = { organizationId: string; providerId: string; issuer: string; oidcConfig: string | null; domainVerified: boolean }
const nonceIdentifier = (providerId: string, state: string) => `enterprise-oidc-logout:${providerId}:${identityTokenHash(state)}`
const cookieKey = (providerId: string) => `enterprise_oidc_logout_${identityTokenHash(providerId).slice(0, 16)}`
function invalidCallback(): never { throw new APIError('BAD_REQUEST', { code: 'ENTERPRISE_LOGOUT_CALLBACK_INVALID', message: 'Invalid or expired logout response' }) }

/** No ID token is retained for logout. The standard client_id path lets an OP
 * confirm logout with its user and enforce its registered callback allowlist. */
export function enterpriseOidcLogoutEndpoints(options: {
  decryptConfig(value: string): string
  record(proof: OidcLogoutProof, reason: LogoutReason, failed?: boolean): void
}) {
  return {
    enterpriseOidcLogout: createAuthEndpoint('/sso/oidc/logout/:providerId', {
      method: 'POST', requireHeaders: true, body: z.object({}).strict().default({}), metadata: { noStore: true },
    }, async ctx => {
      if (!provider.safeParse(ctx.params.providerId).success) invalidCallback()
      const current = await getSessionFromCtx(ctx, { disableCookieCache: true, disableRefresh: true })
      if (!current) throw new APIError('UNAUTHORIZED', { code: 'SESSION_REQUIRED', message: 'Session required' })
      // getSessionFromCtx may already have a cached context; prove the exact current
      // session/provider in the Auth DB before accepting any logout principal.
      const { rows: [proof] } = await pool.query<OidcLogoutProof>(`select "enterpriseOrganizationId" as "organizationId",
        "enterpriseProviderId" as "providerId", "userId", id as "sessionId" from session
        where id=$1 and "userId"=$2 and "expiresAt">now() and "enterpriseOrganizationId" is not null`, [current.session.id, current.user.id])
      if (!proof || proof.providerId !== ctx.params.providerId)
        throw new APIError('FORBIDDEN', { code: 'ENTERPRISE_LOGOUT_SESSION_MISMATCH', message: 'Invalid logout session' })
      try { await ctx.context.internalAdapter.deleteSession(current.session.token) }
      catch (error) {
        const { auditFailureSummary } = await import('../audit/record')
        console.error('[enterprise] logout revocation unavailable', auditFailureSummary(error))
        options.record(proof, 'oidc_local_failed', true)
        // error-cause: classify the DB cause above; native generic errors may log query parameters or bearer values.
        throw new APIError('SERVICE_UNAVAILABLE', { code: 'ENTERPRISE_LOGOUT_UNAVAILABLE', message: 'Logout unavailable' })
      }
      deleteSessionCookie(ctx)
      ctx.setHeader('cache-control', 'no-store')
      ctx.setHeader('referrer-policy', 'no-referrer')
      const signedOutUrl = new URL(withBasePath('/sign-in'), ctx.context.baseURL).href
      const localOnly = (reason: 'oidc_local_only' | 'oidc_provider_unavailable') => {
        options.record(proof, reason)
        return ctx.json({ localSessionRevoked: true, upstream: reason === 'oidc_local_only' ? 'not_supported' as const : 'unavailable' as const, url: signedOutUrl })
      }
      // Upstream configuration, nonce storage, or a later provider outage cannot
      // roll back the local revocation above. Never log provider bodies or URLs.
      try {
        const { rows: [configured] } = await pool.query<ProviderRow>(`select "organizationScopeId" as "organizationId", "providerId", issuer, "oidcConfig", "domainVerified"
          from enterprise_sso_provider where "providerId"=$1 and "organizationScopeId"=$2`, [proof.providerId, proof.organizationId])
        if (!configured?.oidcConfig || !configured.domainVerified) return localOnly('oidc_provider_unavailable')
        const config = JSON.parse(options.decryptConfig(configured.oidcConfig)) as { issuer?: unknown; clientId?: unknown; endSessionEndpoint?: unknown }
        if (config.endSessionEndpoint === undefined || config.endSessionEndpoint === null) return localOnly('oidc_local_only')
        if (typeof config.endSessionEndpoint !== 'string' || typeof config.clientId !== 'string' || !config.clientId || config.issuer !== configured.issuer)
          return localOnly('oidc_provider_unavailable')
        const endpoint = new URL(config.endSessionEndpoint)
        // Management admits only native-validated public HTTPS discovery; use
        // that encrypted endpoint instead of deriving a new endpoint from issuer.
        // HTTP is only reachable through deliberately seeded isolated IdP fixtures.
        if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash)
          return localOnly('oidc_provider_unavailable')
        const redirectUri = `${ctx.context.baseURL.replace(/\/$/, '')}/sso/oidc/logout/callback/${encodeURIComponent(proof.providerId)}`
        const state = randomBytes(32).toString('base64url'), browser = randomBytes(32).toString('base64url')
        const binding = bindingSchema.parse({ version: 1, ...proof, issuer: configured.issuer, clientId: config.clientId, redirectUri,
          browserHash: identityTokenHash(browser), configurationHash: identityTokenHash(configured.oidcConfig) })
        const reserved = await ctx.context.internalAdapter.reserveVerificationValue({ identifier: nonceIdentifier(proof.providerId, state), value: JSON.stringify(binding), expiresAt: new Date(Date.now() + lifetimeSeconds * 1000) })
        if (!reserved) return localOnly('oidc_provider_unavailable')
        const cookie = ctx.context.createAuthCookie(cookieKey(proof.providerId), { path: new URL(redirectUri).pathname, maxAge: lifetimeSeconds, httpOnly: true, sameSite: 'lax' })
        await ctx.setSignedCookie(cookie.name, browser, ctx.context.secret, cookie.attributes)
        for (const parameter of ['id_token_hint', 'logout_hint', 'client_secret']) endpoint.searchParams.delete(parameter)
        endpoint.searchParams.set('client_id', config.clientId)
        endpoint.searchParams.set('post_logout_redirect_uri', redirectUri)
        endpoint.searchParams.set('state', state)
        options.record(proof, 'oidc_upstream_requested')
        return ctx.json({ localSessionRevoked: true, upstream: 'requested' as const, url: endpoint.href })
      } catch { return localOnly('oidc_provider_unavailable') }
    }),
    enterpriseOidcLogoutCallback: createAuthEndpoint('/sso/oidc/logout/callback/:providerId', {
      method: 'GET', requireHeaders: true,
      query: z.object({ state: opaque, error: z.string().max(200).optional(), error_description: z.string().max(2000).optional(), error_uri: z.string().max(2000).optional() }).strict(),
      metadata: { noStore: true },
    }, async ctx => {
      if (!provider.safeParse(ctx.params.providerId).success) invalidCallback()
      const raw = ctx.request ? new URL(ctx.request.url).searchParams : null
      if (raw && (raw.getAll('state').length !== 1 || raw.get('state') !== ctx.query.state)) invalidCallback()
      const identifier = nonceIdentifier(ctx.params.providerId, ctx.query.state)
      const issued = await ctx.context.internalAdapter.findVerificationValue(identifier)
      if (!issued || new Date(issued.expiresAt).getTime() <= Date.now()) invalidCallback()
      let stored: unknown
      try { stored = JSON.parse(issued.value) } catch { invalidCallback() }
      const parsed = bindingSchema.safeParse(stored)
      if (!parsed.success) invalidCallback()
      const binding = parsed.data
      const redirectUri = `${ctx.context.baseURL.replace(/\/$/, '')}/sso/oidc/logout/callback/${encodeURIComponent(ctx.params.providerId)}`
      if (binding.providerId !== ctx.params.providerId || binding.redirectUri !== redirectUri) invalidCallback()
      const cookie = ctx.context.createAuthCookie(cookieKey(binding.providerId), { path: new URL(redirectUri).pathname, maxAge: lifetimeSeconds, httpOnly: true, sameSite: 'lax' })
      const browser = await ctx.getSignedCookie(cookie.name, ctx.context.secret)
      if (typeof browser !== 'string' || !opaque.safeParse(browser).success || !timingSafeEqual(Buffer.from(identityTokenHash(browser), 'hex'), Buffer.from(binding.browserHash, 'hex'))) invalidCallback()
      const { rows: [configured] } = await pool.query<ProviderRow>(`select "organizationScopeId" as "organizationId", "providerId", issuer, "oidcConfig", "domainVerified"
        from enterprise_sso_provider where "providerId"=$1 and "organizationScopeId"=$2`, [binding.providerId, binding.organizationId])
      if (!configured?.domainVerified || !configured.oidcConfig || configured.issuer !== binding.issuer || identityTokenHash(configured.oidcConfig) !== binding.configurationHash) invalidCallback()
      const consumed = await ctx.context.internalAdapter.consumeVerificationValue(identifier)
      if (!consumed || consumed.value !== issued.value) invalidCallback()
      // No session lookup or deletion at callback: a different/new login in this
      // browser must survive an earlier in-flight logout and any replay.
      ctx.setCookie(cookie.name, '', { ...cookie.attributes, maxAge: 0 })
      ctx.setHeader('cache-control', 'no-store')
      ctx.setHeader('referrer-policy', 'no-referrer')
      options.record(binding, ctx.query.error ? 'oidc_upstream_failed' : 'oidc_upstream_returned', Boolean(ctx.query.error))
      throw ctx.redirect(new URL(withBasePath('/sign-in'), ctx.context.baseURL).href)
    }),
  }
}
