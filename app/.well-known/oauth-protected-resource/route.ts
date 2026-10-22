import { generateProtectedResourceMetadata, getPublicOrigin, metadataCorsOptionsRequestHandler } from 'mcp-handler'
import { withBasePath } from '@/lib/base-path'
import { appOrigin, MCP_SCOPE } from '@/lib/mcp/resource'

/**
 * RFC 9728 metadata for the MCP server at /api/mcp: which authorization
 * server signs agents in. The MCP server's 401 points here; the RFC's
 * root path (/.well-known/oauth-protected-resource/mikka/api/mcp) is
 * redirected here in next.config.mjs.
 */
export function GET(request: Request) {
  const origin = appOrigin ?? getPublicOrigin(request)
  const metadata = generateProtectedResourceMetadata({
    authServerUrls: [`${origin}${withBasePath('/api/auth')}`],
    resourceUrl: `${origin}${withBasePath('/api/mcp')}`,
    additionalMetadata: { scopes_supported: [MCP_SCOPE, 'offline_access'], resource_name: 'Mikka' },
  })
  return Response.json(metadata, { headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'max-age=3600' } })
}

export const OPTIONS = metadataCorsOptionsRequestHandler()
