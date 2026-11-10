import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { mcpAuthoritySchema, PluginError, type McpAuthority, type McpServerGrant, type McpWorkspacePage, type McpWorkspaceServerView } from './contracts'
import { assertOrganizationResourceShare, organizationResourceAllowed, workspaceResourcePolicy } from '@/lib/governance/resource-access'

type Query = Pick<Pool | PoolClient, 'query'>
type Workspace = { id: string; kind: 'personal' | 'team'; name: string }
type Row = { id: string; user_id: string; name: string; url: string; transport: 'http' | 'sse'; enabled: boolean; revision: number; auth_header: string | null; created_at: Date; grant_id: string | null }
const columns = 's.id,s.user_id,s.name,s.url,s.transport,s.enabled,s.revision,s.auth_header,s.created_at'
const unavailable = () => new PluginError('mcpUnavailable', 403)

async function workspaceMember(query: Query, userId: string, workspaceId: string): Promise<Workspace> {
  const { rows: [row] } = await query.query<Workspace>(`SELECT w.id,w.kind,m.name FROM mikka_workspaces w
    JOIN mikka_workspace_members m ON m."workspaceId"=w.id AND m."userId"=$2 AND m.status='active'
    WHERE w.id=$1`, [workspaceId, userId])
  if (!row) throw new PluginError('workspaceAccessDenied', 403)
  return row
}
async function activeNames(query: Query, workspaceId: string, ids: string[]): Promise<Map<string, string>> {
  const { rows } = await query.query<{ userId: string; name: string }>(`SELECT "userId",name FROM mikka_workspace_members
    WHERE "workspaceId"=$1 AND "userId"=ANY($2::text[]) AND status='active'`, [workspaceId, [...new Set(ids)]])
  return new Map(rows.map(row => [row.userId, row.name]))
}

/** Query-only validation is usable inside admission/claim's existing transaction. */
export async function validateMcpAuthority(query: Query, userId: string, raw: McpAuthority, membership?: Query): Promise<McpAuthority> {
  const parsed = mcpAuthoritySchema.safeParse(raw)
  if (!parsed.success || parsed.data.requester !== userId) throw unavailable()
  const authority = parsed.data
  const members = authority.workspaceId ? membership ?? (await import('@/lib/workspace-db')).workspacePool : null
  const workspace = authority.workspaceId ? await workspaceMember(members!, userId, authority.workspaceId) : null
  const ids = authority.servers.map(server => server.id)
  if (new Set(ids).size !== ids.length) throw unavailable()
  const names = authority.workspaceId ? await activeNames(members!, authority.workspaceId, [userId, ...authority.servers.map(server => server.ownerId)]) : null
  if (names && !names.has(userId)) throw unavailable()
  const { rows } = await query.query<Row>(`SELECT ${columns},g.id AS grant_id FROM personal_mcp_servers s
    LEFT JOIN personal_mcp_workspace_shares g ON g.server_id=s.id AND g.workspace_id=$2 WHERE s.id=ANY($1::uuid[])`, [ids, authority.workspaceId])
  for (const grant of authority.servers) {
    const row = rows.find(server => server.id === grant.id)
    if (!row?.enabled || row.user_id !== grant.ownerId || row.revision !== grant.revision) throw unavailable()
    if (row.user_id === userId) { if (grant.grantId !== null) throw unavailable() }
    else if (workspace?.kind !== 'team' || !grant.grantId || row.grant_id !== grant.grantId || !names?.has(row.user_id)
      || !await organizationResourceAllowed(authority.workspaceId!, 'mcp', row.id, row.user_id, members!)) throw unavailable()
  }
  return authority
}

/** Existing workspace membership governs an explicit resource grant, never an implicit loan. */
export class WorkspaceMcpStore {
  constructor(readonly pool: Pool, readonly membership?: Query) {}

  private async members() { return this.membership ?? (await import('@/lib/workspace-db')).workspacePool }

  async workspace(userId: string, workspaceId: string): Promise<Workspace> {
    return workspaceMember(await this.members(), userId, workspaceId)
  }

  private async activeNames(workspaceId: string, ids: string[]): Promise<Map<string, string>> {
    return activeNames(await this.members(), workspaceId, ids)
  }

  private async available(userId: string, workspaceId: string | null, query: Query): Promise<Row[]> {
    const workspace = workspaceId ? await this.workspace(userId, workspaceId) : null
    const { rows } = await query.query<Row>(`SELECT ${columns},g.id AS grant_id FROM personal_mcp_servers s
      LEFT JOIN personal_mcp_workspace_shares g ON g.server_id=s.id AND g.workspace_id=$2
      WHERE s.user_id=$1 OR ($3::boolean AND g.id IS NOT NULL AND s.enabled)
      ORDER BY (s.user_id=$1) DESC,s.created_at,s.id`, [userId, workspaceId, workspace?.kind === 'team'])
    if (!workspaceId) return rows
    const names = await this.activeNames(workspaceId, [userId, ...rows.map(row => row.user_id)])
    if (!names.has(userId)) throw unavailable()
    const grants = await Promise.all(rows.map(row => row.user_id === userId ? true : organizationResourceAllowed(workspaceId, 'mcp', row.id, row.user_id, this.membership)))
    return rows.filter((row, index) => row.user_id === userId || (names.has(row.user_id) && grants[index]))
  }

  /** Owner controls stay private; members see only explicitly shared public metadata. */
  async list(userId: string, workspaceId: string): Promise<McpWorkspacePage> {
    const workspace = await this.workspace(userId, workspaceId)
    const rows = await this.available(userId, workspaceId, this.pool)
    const names = await this.activeNames(workspaceId, [userId, ...rows.map(row => row.user_id)])
    const servers: McpWorkspaceServerView[] = rows.map(row => ({
      id: row.id, name: row.name, url: row.user_id === userId ? row.url : null,
      transport: row.transport, enabled: row.enabled, revision: row.revision, authKind: row.auth_header ? 'header' : 'none',
      createdAt: row.created_at.toISOString(), ownerId: row.user_id, ownerName: names.get(row.user_id) ?? null,
      mine: row.user_id === userId, shared: Boolean(row.grant_id),
    }))
    const policy = await workspaceResourcePolicy(workspaceId, await this.members())
    return { workspaceId, workspaceKind: workspace.kind, canShare: workspace.kind === 'team' && policy.mcpSharing !== 'deny', servers, count: servers.length }
  }

  /** Same owner/member boundary as API-key sharing. Only fresh-session HTTP calls invoke this mutation. */
  async share(userId: string, input: { serverId: string; workspaceId: string; shared: boolean }): Promise<McpWorkspacePage> {
    if ((await this.workspace(userId, input.workspaceId)).kind !== 'team') throw new PluginError('workspaceAccessDenied', 403)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const { rowCount } = await client.query('SELECT 1 FROM personal_mcp_servers WHERE id=$1 AND user_id=$2 FOR UPDATE', [input.serverId, userId])
      if (!rowCount) throw new PluginError('mcpNotFound', 404)
      if (input.shared) await assertOrganizationResourceShare(input.workspaceId, 'mcp', input.serverId, userId, await this.members())
      if (input.shared) await client.query(`INSERT INTO personal_mcp_workspace_shares(id,server_id,workspace_id)
        VALUES($1,$2,$3) ON CONFLICT(server_id,workspace_id) DO NOTHING`, [randomUUID(), input.serverId, input.workspaceId])
      else await client.query('DELETE FROM personal_mcp_workspace_shares WHERE server_id=$1 AND workspace_id=$2', [input.serverId, input.workspaceId])
      // Membership is in a separate database. Recheck after lock waits; every use also checks it live.
      await this.workspace(userId, input.workspaceId)
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    return this.list(userId, input.workspaceId)
  }

  /** Freeze IDs, revisions and the distinct owner; no URL, headers, skills or private instructions. */
  async freeze(userId: string, workspaceId: string | null, query: Query = this.pool): Promise<McpAuthority> {
    const rows = (await this.available(userId, workspaceId, query)).filter(row => row.enabled).slice(0, 64)
    return { requester: userId, workspaceId, servers: rows.map(row => ({
      id: row.id, name: row.name, revision: row.revision, ownerId: row.user_id,
      grantId: row.user_id === userId ? null : row.grant_id,
    })) }
  }

  /** No grant discovery here: an old execution can use only the exact references frozen by its host. */
  async validate(userId: string, raw: McpAuthority, query: Query = this.pool): Promise<McpAuthority> {
    return validateMcpAuthority(query, userId, raw, this.membership)
  }
}

/** One connection's grant is rechecked without widening the frozen catalogue. */
export function singleMcpAuthority(authority: McpAuthority, id: string): McpAuthority & { servers: [McpServerGrant] } {
  const grant = authority.servers.find(server => server.id === id)
  if (!grant) throw new PluginError('mcpNotEnabledForExecution', 403)
  return { ...authority, servers: [grant] }
}
