import 'server-only'
import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import type { AuthInfo } from '@modelcontextprotocol/server'
import { db } from '@/lib/db'
import { MCP_SCOPE } from '@/lib/mcp/resource'
import { agentActor, type ActivityActor } from '@/lib/activity-actor'

/** Prefix the OAuth provider puts on access tokens (lib/auth.ts); it is not stored. */
const ACCESS_TOKEN_PREFIX = 'mka_'

/** The person an MCP request acts for. */
export function mcpUserId(authInfo: AuthInfo | undefined): string {
  const userId = authInfo?.extra?.userId
  if (typeof userId !== 'string') throw new Error('MCP request is not authenticated')
  return userId
}

/** Who issue history records for an MCP write: the agent behind the verified token (its OAuth client id, or `run:<id>` for a run token). */
export function mcpActor(authInfo: AuthInfo | undefined): ActivityActor {
  return agentActor(typeof authInfo?.clientId === 'string' && authInfo.clientId ? authInfo.clientId : null)
}

/**
 * Checks an access token issued by the OAuth provider plugin. Tokens are
 * opaque and stored as base64url SHA-256, the plugin's own hashing. A token is
 * good while it is unexpired, unrevoked, its client is enabled, and the sign-in
 * it came from has not expired; the same checks as the plugin's introspection.
 */
export async function verifyMcpToken(_request: Request, bearerToken?: string): Promise<AuthInfo | undefined> {
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
  return {
    token: bearerToken, clientId: row.clientId, scopes: row.scopes,
    expiresAt: Math.floor(new Date(row.expiresAt).getTime() / 1000),
    extra: { userId: row.userId },
  }
}
