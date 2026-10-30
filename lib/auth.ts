import { betterAuth } from 'better-auth'
import { createAuthMiddleware } from 'better-auth/api'
import { deviceAuthorization, multiSession } from 'better-auth/plugins'
import { nextCookies } from 'better-auth/next-js'
import { oauthProvider } from '@better-auth/oauth-provider'
import { expo } from '@better-auth/expo'
import { oAuthProxy, oneTimeToken } from 'better-auth/plugins'
import { pool } from '@/lib/db'
import { BASE_PATH, withBasePath } from '@/lib/base-path'
import { appOrigin, MCP_SCOPE, mcpResourceURL } from '@/lib/mcp/resource'
import { authOAuthProxyOptions, authTrustedOrigins } from '@/lib/auth-config'
import { createAuthEmail, type AuthMailContext } from '@/lib/auth-email'
import { after } from 'next/server'
import { githubVerifiedProfile } from '@/lib/auth-github-profile'
import { beforeSignup } from '@/lib/abuse/signup'
import { newUserAvatar } from '@/lib/default-avatar'
import { daemonAuthorizationOptions, exchangeDaemonSession } from '@/lib/daemon-authorization'
import { issueDeviceToken } from '@/lib/device-link'

/** The iOS app's URL scheme: OAuth returns here, and its requests carry it as their origin. */
export const MOBILE_APP_ORIGIN = 'mikka://'

export const githubEnabled = Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET)
export const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
export const authBaseURL = appOrigin
const proxyOptions = authOAuthProxyOptions(process.env)
export const oauthCallbackBaseURL = proxyOptions?.productionURL ?? authBaseURL
const email = createAuthEmail({
  origin: authBaseURL ?? 'http://localhost:3000',
  apiKey: () => process.env.RESEND_API_KEY,
  context: async (): Promise<AuthMailContext> => auth.$context,
  background: task => after(task),
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
    // A new account without a picture gets a default avatar now; older accounts are left as they are.
    user: { create: { before: async user => ({ data: { ...user, image: user.image || newUserAvatar(user.name || user.email) } }) } },
    account: {
      create: { before: async account => ({ data: { ...account, idToken: null } }) },
      update: { before: async account => ({ data: { ...account, idToken: null } }) },
    },
  },
  socialProviders: {
    ...(githubEnabled ? { github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
      getUserInfo: githubVerifiedProfile(),
      requireEmailVerification: true,
    } } : {}),
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
  rateLimit: { ...email.rateLimit, storage: 'database' },
  trustedOrigins: [
    ...authTrustedOrigins(process.env),
    ...(process.env.NODE_ENV === 'development' ? ['http://localhost:3000'] : []),
    // The iOS app's deep link (apps/mobile app.json scheme); Expo Go uses exp:// while developing.
    MOBILE_APP_ORIGIN,
    ...(process.env.NODE_ENV === 'development' ? ['exp://'] : []),
  ],
  // Makes the app an OAuth 2.1 server so agents (Claude Code, Codex…) can sign
  // in to the MCP server at /api/mcp as the person. Clients register
  // themselves (RFC 7591) and use PKCE; access tokens are opaque and hashed in
  // the database, and lib/mcp/auth.ts checks them.
  plugins: [
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
    before: createAuthMiddleware(async ctx => { await beforeSignup(pool,ctx); return email.before(ctx) }),
    after: createAuthMiddleware(async ctx => {
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
  session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
  ...(process.env.NODE_ENV === 'development' && authBaseURL?.startsWith('https://') ? { advanced: {
    // Partition preview sessions by top-level site when third-party cookies are blocked.
    defaultCookieAttributes: { sameSite: 'none' as const, secure: true, partitioned: true },
  } } : {}),
})
