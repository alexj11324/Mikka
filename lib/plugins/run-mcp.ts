import 'server-only'
import type { AuthInfo } from '@modelcontextprotocol/server'
import type { Pool, PoolClient } from 'pg'
import { pool } from '@/lib/db'
import { activeExecutionIdentity } from '@/lib/execution-identity'
import { verifyRunToken, workerRun } from '@/lib/mcp/worker'
import { mcpAuthoritySchema, PluginError, type McpAuthority } from './contracts'
import { createPersonalMcpRuntime, type PersonalMcpCommand, type McpDependencies } from './mcp'
import { personalPlugins } from './runtime'

/** Uses the existing app MCP transport; no remote credential reaches a daemon. */
export const CUSTOM_MCP_TOOLKIT = 'custom_mcp'
type Query = Pick<Pool | PoolClient, 'query'>

export async function runMcpAuthority(userId: string, runId: string, query: Query = pool, membership?: Query): Promise<McpAuthority | null> {
  const { rows: [row] } = await query.query<{ customMcp: unknown }>(`SELECT "agentDefinition"->'customMcp' AS "customMcp"
    FROM agent_runs WHERE id=$1 AND "userId"=$2`, [runId, userId])
  // Historical tokens do not discover new workspace grants.
  if (!row?.customMcp) return null
  const parsed = mcpAuthoritySchema.safeParse(row.customMcp)
  if (!parsed.success || parsed.data.requester !== userId) throw new PluginError('mcpUnavailable', 403)
  const identity = await activeExecutionIdentity(query, runId, userId, membership)
  if (!identity || identity.workspaceId !== parsed.data.workspaceId) throw new PluginError('mcpUnavailable', 403)
  return parsed.data
}

export async function runMcpAdvertised(userId: string, runId: string): Promise<boolean> {
  return Boolean((await runMcpAuthority(userId, runId))?.servers.length)
}

/** The same token is checked again after remote initialization, before any tool side effect. */
export async function runCustomMcp(request: Request, auth: AuthInfo, command: PersonalMcpCommand, dependencies?: McpDependencies) {
  const scope = workerRun(auth)
  const guard = async () => {
    const verified = await verifyRunToken(request, auth.token)
    if (!verified || verified.extra?.runId !== scope.id || verified.extra.userId !== scope.userId) throw new PluginError('mcpUnavailable', 403)
    const authority = await runMcpAuthority(scope.userId, scope.id)
    if (!authority?.servers.some(server => server.id === command.serverId)) throw new PluginError('mcpNotEnabledForExecution', 403)
  }
  const authority = await runMcpAuthority(scope.userId, scope.id)
  if (!authority) return { error: 'mcpNotEnabledForExecution' }
  return createPersonalMcpRuntime(personalPlugins, dependencies)(scope.userId, {
    servers: authority.servers.map(({ id, name, revision }) => ({ id, name, revision })), skills: [], mcpAuthority: authority,
  }, command, guard)
}
