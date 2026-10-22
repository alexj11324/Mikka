import { betterAuth } from 'better-auth'
import { createAuthMiddleware } from 'better-auth/api'
import { multiSession } from 'better-auth/plugins'
import { nextCookies } from 'better-auth/next-js'
import { oauthProvider } from '@better-auth/oauth-provider'
import { pool } from '@/lib/db'
import { withBasePath } from '@/lib/base-path'
import { appOrigin, MCP_SCOPE, mcpResourceURL } from '@/lib/mcp/resource'

export const githubEnabled = Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET)
export const googleEnabled = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
export const authBaseURL = appOrigin

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
    account: {
      create: { before: async account => ({ data: { ...account, idToken: null } }) },
      update: { before: async account => ({ data: { ...account, idToken: null } }) },
    },
  },
  socialProviders: {
    ...(githubEnabled ? { github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
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
  emailAndPassword: { enabled: true, autoSignIn: true },
  trustedOrigins: [
    ...(process.env.NODE_ENV === 'development' ? ['http://localhost:3000', ...[process.env.V0_RUNTIME_URL, process.env.V0_DEV_APP_URL, process.env.V0_BUILD_URL, process.env.V0_SANDBOX_URL].filter((value): value is string => !!value)] : []),
    ...(process.env.NODE_ENV === 'production' ? [...(process.env.VERCEL_URL ? [`https://${process.env.VERCEL_URL}`] : []), ...(process.env.VERCEL_PROJECT_PRODUCTION_URL ? [`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`] : [])] : []),
  ],
  plugins: [
    multiSession(),
    // OAuth 2.1 lets external agents access the MCP server as the signed-in person.
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
    after: createAuthMiddleware(async ctx => {
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
  ...(process.env.NODE_ENV === 'development' ? { advanced: {
    // Partition preview sessions by top-level site when third-party cookies are blocked.
    defaultCookieAttributes: { sameSite: 'none' as const, secure: true, partitioned: true },
  } } : {}),
})
