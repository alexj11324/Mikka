import 'server-only'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { AuthInfo } from '@modelcontextprotocol/server'
import { db, pool } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { appendAudit } from '@/lib/audit/store'
import { withPolicyTool } from '@/lib/policy/runtime'
import { randomUUID } from 'node:crypto'
import { MCP_SCOPE } from '@/lib/mcp/resource'

/** Prefix the OAuth provider puts on access tokens (lib/auth.ts); it is not stored. */
const ACCESS_TOKEN_PREFIX = 'mka_'

/** The person an MCP request acts for. */
export function mcpUserId(authInfo: AuthInfo | undefined): string {
  const userId = authInfo?.extra?.userId
  if (typeof userId !== 'string') throw new Error('MCP request is not authenticated')
  return userId
}

/**
 * Checks an access token issued by the OAuth provider plugin. Tokens are
 * opaque and stored as base64url SHA-256, the plugin's own hashing. A token is
 * good while it is unexpired, unrevoked, its client is enabled, and the sign-in
 * it came from has not expired; the same checks as the plugin's introspection.
 */
export async function verifyMcpToken(request: Request, bearerToken?: string): Promise<AuthInfo | undefined> {
  if (!bearerToken?.startsWith(ACCESS_TOKEN_PREFIX)) return undefined
  const hash = createHash('sha256').update(bearerToken.slice(ACCESS_TOKEN_PREFIX.length)).digest('base64url')
  const { rows } = await db.execute<{ userId: string; clientId: string; scopes: string[]; expiresAt: Date }>(sql`
    select t."userId", t."clientId", t.scopes, t."expiresAt"
    from "oauthAccessToken" t
    join "oauthClient" c on c."clientId" = t."clientId"
    left join "session" s on s.id = t."sessionId"
    where t.token = ${hash} and t.revoked is null and t."expiresAt" > now() and t."userId" is not null
      and coalesce(c.disabled, false) = false
      and (t."sessionId" is null or s."expiresAt" > now())
    limit 1`)
  const row = rows[0]
  if (!row || !row.scopes.includes(MCP_SCOPE)) return undefined
  const workspaces = (await workspacePool.query(`SELECT "workspaceId" FROM mikka_workspace_members WHERE "userId"=$1 AND status='active' ORDER BY "workspaceId"`, [row.userId])).rows.map(r => r.workspaceId as string)
  const suppliedId = request.headers.get('x-request-id')
  const requestId = suppliedId && /^[a-f0-9-]{36}$/i.test(suppliedId) ? suppliedId : randomUUID()
  await appendAudit(pool, `personal:${row.userId}`, { actorId: row.userId, actorType: 'human', resourceId: 'oauth-mcp', action: 'mcp.authenticated', outcome: 'success', reason: 'oauthAuthenticated', requestId })
  return {
    token: bearerToken, clientId: row.clientId, scopes: row.scopes,
    expiresAt: Math.floor(new Date(row.expiresAt).getTime() / 1000),
    extra: { userId: row.userId, policyWorkspaces: workspaces },
  }
}

const localMcpTools = new Set(['stop_run', 'read_coordinator_messages', 'list_issues', 'get_issue', 'list_runs', 'get_run', 'get_run_events', 'search_issues', 'list_projects', 'list_labels', 'list_agents', 'read_coordinator_memory'])

/** Recheck the bearer after body parsing. Request-time memberships are trusted
 * server state: removal while a body is delayed cannot downgrade to personal. */
export async function withMcpTool<T>(authInfo: AuthInfo | undefined, name: string, work: () => Promise<T>): Promise<T> {
  const userId = mcpUserId(authInfo)
  const fresh = await verifyMcpToken(new Request('http://localhost/internal-mcp-check'), authInfo?.token)
  if (!fresh || mcpUserId(fresh) !== userId) throw new Error('mcpAuthorizationRevoked')
  const captured = authInfo?.extra?.policyWorkspaces
  if (!Array.isArray(captured) || captured.some(id => typeof id !== 'string')) throw new Error('mcpPolicyContextMissing')
  // Stopping work must remain possible after policy revocation.
  if (localMcpTools.has(name)) return work()
  return withPolicyTool(userId, work, captured as string[])
}
