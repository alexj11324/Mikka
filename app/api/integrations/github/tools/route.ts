import { auth } from '@/lib/api-auth'
import { withRequestLog } from '@/lib/request-log'
import { readAppToolCatalogue } from '@/lib/app-tool-catalogue'


const headers = { 'Cache-Control': 'private, no-store' }

/**
 * Plugins › GitHub's abilities: the tools GitHub's hosted MCP server lists for this person, read live with their
 * own credential through the same runtime the Coordinator's `github_tools` uses (lib/github/mcp.ts), every page.
 * Names, titles, descriptions and the read-only mark are GitHub's; no credential leaves the server.
 */
async function handleGET(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers })
  if (!session?.user) return Response.json({ error: 'authRequired' }, { status: 401, headers })
  const viewerId = session.user.id
  try {
    const catalogue = await readAppToolCatalogue(viewerId, 'github')
    if (catalogue.error) {
      const error = catalogue.error
      if (error === 'githubNotConnected' || error === 'githubNotConfigured') return Response.json({ viewerId, error: 'githubNotConnected' }, { status: 409, headers })
      if (error === 'githubReconnectRequired') return Response.json({ viewerId, error }, { status: 401, headers })
      if (error === 'authRequired') return Response.json({ viewerId, error }, { status: 401, headers })
      return Response.json({ viewerId, error: 'githubUnavailable' }, { status: 502, headers })
    }
    return Response.json({ viewerId, tools: catalogue.tools.map(tool => ({ name: tool.name, displayName: tool.displayName, readOnly: tool.readOnly, ...(tool.description ? { description: tool.description } : {}) })),
      count: catalogue.count, readOnlyCount: catalogue.readOnlyCount, truncated: catalogue.truncated }, { headers })
  } catch {
    return Response.json({ viewerId, error: 'githubUnavailable' }, { status: 502, headers })
  }
}

export const GET = withRequestLog('/api/integrations/github/tools', handleGET)
