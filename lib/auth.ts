import { betterAuth } from 'better-auth'
import { createAuthMiddleware } from 'better-auth/api'
import { bearer, deviceAuthorization, multiSession } from 'better-auth/plugins'
import { nextCookies } from 'better-auth/next-js'
import { oauthProvider } from '@better-auth/oauth-provider'
import { expo } from '@better-auth/expo'
import { oAuthProxy, oneTimeToken } from 'better-auth/plugins'
import { pool } from '@/lib/db'
import { BASE_PATH, withBasePath } from '@/lib/base-path'
import { appOrigin, MCP_SCOPE, mcpResourceURL } from '@/lib/mcp/resource'
import { authOAuthProxyOptions, authEffectiveTrustedOrigins, authSignInMethods, authAppleOptions, requireAppleSignInNonce } from '@/lib/auth-config'
import { createAuthEmail, type AuthMailContext } from '@/lib/auth-email'
import { afterJob } from '@/lib/background'
import { githubVerifiedProfile } from '@/lib/auth-github-profile'
import { githubSignInClient } from '@/lib/github/app-config'
import { beforeSignup, localSignUpRateRules } from '@/lib/abuse/signup'
import { newUserAvatar } from '@/lib/default-avatar'
import { daemonAuthorizationOptions, exchangeDaemonSession } from '@/lib/daemon-authorization'
import { issueDeviceToken } from '@/lib/device-link'
import { auditAuthentication } from '@/lib/audit/authentication'
import { readFreshSessionsInScope, SESSION_OPTIONS } from '@/lib/fresh-session'
import { desktopSessionCacheAfter, withDesktopSessionCache } from '@/lib/desktop-rpc/session-cache'
import { completeEnterpriseSignIn, enterpriseIdentityModels, enterpriseSessionFields, enterpriseSso, ssoSessionData, withEnterpriseAuthRequest } from '@/lib/enterprise/sso-plugin'

/** The iOS app's URL scheme: OAuth returns here, and its requests carry it as their origin. */
export { MOBILE_APP_ORIGIN } from '@/lib/auth-config'

export const { github: githubEnabled, google: googleEnabled } = authSignInMethods(process.env)
export const authBaseURL = appOrigin
const appleOptions = authAppleOptions(process.env)
const proxyOptions = authOAuthProxyOptions(process.env)
export const oauthCallbackBaseURL = proxyOptions?.productionURL ?? authBaseURL
const email = createAuthEmail({
  origin: authBaseURL ?? 'http://localhost:3000',
  apiKey: () => process.env.RESEND_API_KEY,
  context: async (): Promise<AuthMailContext> => auth.$context,
  background: task => afterJob('after:auth-email', task),
})

export type DeviceSessionSummary = {
  session: { token: string }
  user: { id: string; email: string }
}

export const auth = betterAuth({
  appName: 'Mikka',
  onAPIError: { errorURL: withBasePath('/sign-in?oauth=failed') },
  database: pool,
  account: { encryptOAuthTokens: true, accountLinking: { trustedProviders: [] } },
  databaseHooks: {
    session: {
      create: { before: async session => ({ data: { ...session, ...ssoSessionData(session.userId) } }) },
      // Native hooks run after the deletion transaction commits. The durable
      // trigger already persisted revocation; transport retries must not hold auth.
      delete: { after: async session => {
        (await import('@/lib/enterprise/live-authority')).scheduleSessionLiveRevocation(session.userId)
        await (await import('@/lib/resource-access/lifecycle')).sessionResourceAuthorityChanged(session.userId)
      } },
      update: { after: async session => {
        await (await import('@/lib/resource-access/lifecycle')).sessionResourceAuthorityChanged(session.userId)
      } },
    },
    // A new account without a picture gets a default avatar now; older accounts are left as they are.
    user: { create: {
      before: async user => ({ data: { ...user, image: user.image || newUserAvatar(user.name || user.email) } }),
      // Every person's first workspace is their personal one (decision 2026-11-02-1500). Loading any
      // workspace page creates it too, so a failure here only delays it.
      after: async user => {
        try {
          const { ensurePersonalWorkspace } = await import('@/lib/personal-workspace')
          await ensurePersonalWorkspace({ id: user.id, email: user.email, name: user.name }, 'zh-CN')
        } catch (error) { console.error('Personal workspace at sign-up failed', error instanceof Error ? error.name : 'UnknownError') }
      },
    } },
    account: {
      create: { before: async account => ({ data: { ...account, idToken: null } }) },
      update: { before: async account => ({ data: { ...account, idToken: null } }) },
    },
  },
  socialProviders: {
    ...(appleOptions ? { apple: appleOptions } : {}),
    github: async () => ({
      ...await githubSignInClient(),
      getUserInfo: githubVerifiedProfile(),
      requireEmailVerification: true,
    }),
    ...(googleEnabled ? { google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      scope: ['openid', 'email', 'profile'],
      includeGrantedScopes: false,
      requireEmailVerification: true,
    } } : {}),
  },
  baseURL: authBaseURL,
  // Its routes sit under the app's base path (app/api/auth → /mikka/api/auth).
  basePath: withBasePath('/api/auth'),
  emailAndPassword: email.emailAndPassword,
  emailVerification: email.emailVerification,
  rateLimit: { ...email.rateLimit, customRules: { ...email.rateLimit.customRules, ...localSignUpRateRules(process.env) }, storage: 'database' },
  trustedOrigins: authEffectiveTrustedOrigins(process.env),
  // Makes the app an OAuth 2.1 server so agents (Claude Code, Codex…) can sign
  // in to the MCP server at /api/mcp as the person. Clients register
  // themselves (RFC 7591) and use PKCE; access tokens are opaque and hashed in
  // the database, and lib/mcp/auth.ts checks them.
  plugins: [
    enterpriseIdentityModels,
    enterpriseSso(),
    bearer(),
    ...(proxyOptions ? [oAuthProxy(proxyOptions)] : []),
    // The iOS app signs in through the system browser and keeps its session cookie in the keychain.
    expo(),
    // The app opens a web page signed in as the person (app/api/mobile/open): a one-minute, single-use token, stored hashed.
    oneTimeToken({ expiresIn: 1, storeToken: 'hashed' }),
    multiSession(),
    deviceAuthorization(daemonAuthorizationOptions(BASE_PATH)),
    oauthProvider({
      loginPage: withBasePath('/sign-in'),
      consentPage: withBasePath('/oauth/consent'),
      scopes: [MCP_SCOPE, 'offline_access'],
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      clientRegistrationDefaultScopes: [MCP_SCOPE, 'offline_access'],
      clientRegistrationAllowedScopes: [MCP_SCOPE, 'offline_access'],
      ...(mcpResourceURL ? { resources: [mcpResourceURL], clientRegistrationDefaultResources: [mcpResourceURL] } : {}),
      grantTypes: ['authorization_code', 'refresh_token'],
      disableJwtPlugin: true,
      prefix: { opaqueAccessToken: 'mka_', refreshToken: 'mkr_' },
    }),
    nextCookies(),
  ],
  hooks: {
    before: createAuthMiddleware(async ctx => {
      requireAppleSignInNonce(ctx)
      await beforeSignup(pool,ctx)
      return email.before(ctx)
    }),
    after: createAuthMiddleware(async ctx => {
      await completeEnterpriseSignIn(ctx)
      await auditAuthentication(ctx)
      const deviceToken = await exchangeDaemonSession({
        path: ctx.path, clientId: ctx.body?.client_id,
        returned: ctx.context.returned, newSession: ctx.context.newSession,
      }, {
        issueToken: userId => issueDeviceToken(userId),
        revokeSession: token => ctx.context.internalAdapter.deleteSession(token),
      })
      if (deviceToken) {
        ctx.context.newSession = null
        ctx.setHeader('cache-control', 'no-store')
        ctx.setHeader('pragma', 'no-cache')
        return ctx.json(deviceToken)
      }
      if (ctx.path === '/verify-email' || ctx.path?.startsWith('/reset-password')) {
        ctx.setHeader('referrer-policy', 'no-referrer')
        ctx.setHeader('cache-control', 'no-store')
      }
      const requestResult = await email.publicRequestResult(ctx.path, ctx.context.returned, ctx.request)
      if (requestResult) return Response.json(requestResult, { status: 202, headers: { 'cache-control': 'no-store' } })
      // Publish the private SDK cache only after sign-in auditing succeeds;
      // a withheld/revoked sign-in must never receive a usable cached proof.
      desktopSessionCacheAfter(ctx)
      // Preserve sessions issued before multi-session was enabled when adding the first extra account.
      if (ctx.path !== '/get-session' || !ctx.request || ctx.headers?.get('cookie')?.includes('_multi-')) return
      const active = ctx.context.session
      if (!active || active.session.expiresAt <= new Date()) return
      const cookie = ctx.context.authCookies.sessionToken
      await ctx.setSignedCookie(`${cookie.name}_multi-${active.session.token.toLowerCase()}`, active.session.token, ctx.context.secret, {
        ...cookie.attributes,
        maxAge: Math.max(0, Math.floor((active.session.expiresAt.getTime() - Date.now()) / 1000)),
      })
    }),
  },
  // Polls read the session from a signed cookie for up to 5 minutes instead of two queries each time (Alex
  // 2026-11-02). Money, permissions, credentials and deletion read it fresh (lib/fresh-session.ts).
  session: { ...SESSION_OPTIONS, storeSessionInDatabase: true, additionalFields: enterpriseSessionFields },
  // Organization identity management uses the fresh-session, organization-admin route.
  disabledPaths: ['/sso/register', '/sso/update-provider', '/sso/delete-provider', '/sso/providers', '/sso/get-provider', '/sso/request-domain-verification', '/sso/verify-domain'],
  advanced: {
    // Migrations own the schema (scripts/migrate.mjs on every deploy). Better Auth's own check reads
    // every column of every table from the catalog on each cold start, about 225 KB a time.
    database: { validateSchema: false },
    // Partition preview sessions by top-level site when third-party cookies are blocked.
    ...(process.env.NODE_ENV === 'development' && authBaseURL?.startsWith('https://') ? {
      defaultCookieAttributes: { sameSite: 'none' as const, secure: true, partitioned: true },
    } : {}),
  },
})

/** The provider Better Auth actually initialized, including the explicitly opted-in server App. */
export async function githubSignInEnabled(): Promise<boolean> {
  return (await auth.$context).socialProviders.some(provider => provider.id === 'github')
}

// Inside withFreshSession (money, permissions, credentials, deletion) a session read skips the cookie cache.
readFreshSessionsInScope(auth.api, { cookieName: async () => (await auth.$context).authCookies.sessionData.name })
auth.handler = withEnterpriseAuthRequest(withDesktopSessionCache(auth.handler, async () => (await auth.$context).authCookies.sessionData.name))
