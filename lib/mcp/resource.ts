import { withBasePath } from '@/lib/base-path'

/** The one scope an MCP access token needs: act in Mikka as the person. */
export const MCP_SCOPE = 'mikka'

/** Where the app is served, e.g. https://app.aspectlylabs.com; better-auth's base URL. */
export const appOrigin = (process.env.BETTER_AUTH_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : process.env.V0_RUNTIME_URL))?.replace(/\/$/, '')

/** The MCP server's URL. Clients name it as the OAuth `resource` (RFC 8707). */
export const mcpResourceURL = appOrigin ? `${appOrigin}${withBasePath('/api/mcp')}` : undefined

/** The OAuth issuer: better-auth's base URL plus its base path. */
export const authIssuerURL = appOrigin ? `${appOrigin}${withBasePath('/api/auth')}` : undefined
