import type { AuthInfo } from '@modelcontextprotocol/server'
import { fromJsonSchema } from '@modelcontextprotocol/server'
import { createMcpHandler, withMcpAuth } from 'mcp-handler'
import { withBasePath } from '@/lib/base-path'
import { verifyRunToken } from '@/lib/mcp/worker'
import { authorizeRunApp } from '@/lib/run-app-mcp'
import { runAppEntry, runAppToolkits } from '@/lib/app-tools-server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// One connected app (Composio toolkit) as its own MCP server for a device
// run's Claude Code or Codex. Credentials stay here; the run token names the
// owner, Bot and run, and every call follows the cloud Bot's rules
// (lib/app-tools.ts): explicit allow/ask/deny first, and only destructive
// writes become an approval card.

function result(value: unknown) {
  const failed = Boolean(value && typeof value === 'object' && 'error' in value)
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], ...(failed ? { isError: true } : {}) }
}

async function serve(request: Request, toolkit: string) {
  const scope = await authorizeRunApp((request as Request & { auth?: AuthInfo }).auth, toolkit, runAppToolkits)
  const entry = scope && runAppEntry(scope)
  if (!entry) return Response.json({ error: 'runAppUnavailable' }, { status: 403, headers: { 'cache-control': 'no-store' } })
  let tools: Awaited<ReturnType<typeof entry.list>>
  try { tools = await entry.list() } catch { return Response.json({ error: 'integrationToolsUnavailable' }, { status: 502, headers: { 'cache-control': 'no-store' } }) }
  return createMcpHandler(server => {
    for (const tool of tools) {
      server.registerTool(tool.name, {
        description: tool.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(tool.inputSchema as never),
        annotations: { readOnlyHint: tool.readOnly },
      }, async args => result(await entry.call(tool.name, args)))
    }
  }, { serverInfo: { name: `mikka-${toolkit}`, version: '1.0.0' } })(request)
}

async function route(request: Request, context: { params: Promise<{ toolkit: string }> }) {
  const { toolkit } = await context.params
  return withMcpAuth(authed => serve(authed, toolkit), verifyRunToken, { required: true, resourceMetadataPath: withBasePath('/.well-known/oauth-protected-resource') })(request)
}

export { route as GET, route as POST, route as DELETE }
