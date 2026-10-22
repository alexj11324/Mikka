import { withBasePath } from '@/lib/base-path'
import { resolveAppOrigin } from '@/lib/auth-config'

/** The one scope an MCP access token needs: act in Mikka as the person. */
export const MCP_SCOPE = 'mikka'

/** Where the app is served, e.g. https://app.aspectlylabs.com; better-auth's base URL. */
export const appOrigin = resolveAppOrigin(process.env)

/** The MCP server's URL. Clients name it as the OAuth `resource` (RFC 8707). */
export const mcpResourceURL = appOrigin ? `${appOrigin}${withBasePath('/api/mcp')}` : undefined

/** The OAuth issuer: better-auth's base URL plus its base path. */
export const authIssuerURL = appOrigin ? `${appOrigin}${withBasePath('/api/auth')}` : undefined
