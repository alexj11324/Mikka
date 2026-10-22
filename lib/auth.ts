import { betterAuth } from 'better-auth'
import { oauthProvider } from '@better-auth/oauth-provider'
import { pool } from '@/lib/db'
import { withBasePath } from '@/lib/base-path'
import { appOrigin, MCP_SCOPE, mcpResourceURL } from '@/lib/mcp/resource'

export const githubEnabled = Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET)
export const authBaseURL = appOrigin

export const auth = betterAuth({
  appName: 'Mikka',
  onAPIError: { errorURL: withBasePath('/sign-in?oauth=failed') },
  database: pool,
  socialProviders: githubEnabled ? {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    },
  } : {},
  baseURL: authBaseURL,
  // Its routes sit under the app's base path (app/api/auth → /mikka/api/auth).
  basePath: withBasePath('/api/auth'),
  emailAndPassword: { enabled: true, autoSignIn: true },
  trustedOrigins: [
    ...(process.env.NODE_ENV === 'development' ? ['http://localhost:3000', ...[process.env.V0_RUNTIME_URL, process.env.V0_DEV_APP_URL, process.env.V0_BUILD_URL, process.env.V0_SANDBOX_URL].filter((value): value is string => !!value)] : []),
    ...(process.env.NODE_ENV === 'production' ? [...(process.env.VERCEL_URL ? [`https://${process.env.VERCEL_URL}`] : []), ...(process.env.VERCEL_PROJECT_PRODUCTION_URL ? [`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`] : [])] : []),
  ],
  // Makes the app an OAuth 2.1 server so agents (Claude Code, Codex…) can sign
  // in to the MCP server at /api/mcp as the person. Clients register
  // themselves (RFC 7591) and use PKCE; access tokens are opaque and hashed in
  // the database, and lib/mcp/auth.ts checks them.
  plugins: [oauthProvider({
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
  })],
  session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
  ...(process.env.NODE_ENV === 'development' ? { advanced: {
    // Partition preview sessions by top-level site when third-party cookies are blocked.
    defaultCookieAttributes: { sameSite: 'none' as const, secure: true, partitioned: true },
  } } : {}),
})
