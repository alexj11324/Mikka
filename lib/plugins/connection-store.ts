import type { PoolClient } from 'pg'
import { z } from 'zod'
import { PluginError } from './contracts'
import type { PersonalPluginStore } from './store'
import { WorkspaceMcpStore } from './workspace-mcp'
import { mcpEnvironmentSettings, mcpToolName, type McpConnectionDetails, type McpConnectionStatus, type McpToolView } from './connection-contracts'
import { McpOAuthStore } from './mcp-oauth'
import { mcpFailure, runMcpCommand, type McpDependencies } from './mcp'

const pageSchema = z.object({ tools: z.array(z.object({ name: mcpToolName, description: z.string().max(100_000).optional() })), nextCursor: z.string().max(2048).nullable() })

export class McpConnectionStore {
  constructor(readonly personal: PersonalPluginStore, readonly dependencies: McpDependencies = {},
    readonly oauth = new McpOAuthStore(personal.pool, personal.env)) {}
  private async owned(userId: string, serverId: string) {
    const server = (await this.personal.listMcp(userId)).find(row => row.id === serverId)
    if (!server) throw new PluginError('mcpNotFound', 404)
    return server
  }
  private async members() { return this.personal.membership ?? (await import('@/lib/workspace-db')).workspacePool }

  async detail(userId: string, serverId: string, workspaceId?: string): Promise<McpConnectionDetails> {
    const candidates = workspaceId ? (await new WorkspaceMcpStore(this.personal.pool, this.personal.membership).list(userId, workspaceId)).servers : await this.personal.listMcp(userId)
    const server = candidates.find(row => row.id === serverId)
    if (!server) throw new PluginError('mcpNotFound', 404)
    const mine = !('mine' in server) || server.mine
    const { rows: [state] } = await this.personal.pool.query<{ connection_status: McpConnectionStatus; last_checked_at: Date | null; check_failure: string | null }>(
      'SELECT connection_status,last_checked_at,check_failure FROM personal_mcp_servers WHERE id=$1', [serverId])
    if (!state) throw new PluginError('mcpNotFound', 404)
    const { rows: tools } = await this.personal.pool.query<McpToolView>(`SELECT tool_name AS name,enabled,description,available FROM mcp_server_tools
      WHERE server_id=$1 AND ($2::boolean OR (enabled AND available)) ORDER BY tool_name`, [serverId, mine])
    const { rows: environments } = await this.personal.pool.query<{ environment_id: string }>(`SELECT environment_id FROM mcp_server_environments
      WHERE server_id=$1 AND ($2::boolean OR workspace_id=$3) ORDER BY environment_id`, [serverId, mine, workspaceId ?? null])
    return { id: serverId, status: server.enabled ? state.connection_status : 'disabled', lastCheckedAt: state.last_checked_at?.toISOString() ?? null,
      failureReason: state.check_failure, authorizationUrl: mine ? await this.oauth.authorizationUrl(userId, serverId) : null,
      tools, environmentIds: environments.map(row => row.environment_id) }
  }

  async search(userId: string, options: { workspaceId?: string; query?: string; environmentId?: string } = {}) {
    const page = options.workspaceId ? await new WorkspaceMcpStore(this.personal.pool, this.personal.membership).list(userId, options.workspaceId) : null
    const servers = page?.servers ?? await this.personal.listMcp(userId)
    const query = (options.query ?? '').trim().toLowerCase()
    if (query.length > 200) throw new PluginError('invalidPluginInput', 400)
    const details = await Promise.all(servers.map(async server => ({ ...server, ...await this.detail(userId, server.id, options.workspaceId) })))
    const matched = details.filter(server => (!options.environmentId || !server.environmentIds.length || server.environmentIds.includes(options.environmentId)) &&
      (!query || [server.name, server.url ?? '', ...server.tools.map(tool => tool.name)].some(value => value.toLowerCase().includes(query))))
    return { ...(page ? { workspaceId: page.workspaceId, workspaceKind: page.workspaceKind, canShare: page.canShare } : {}), servers: matched, count: matched.length }
  }

  private async write<T>(userId: string, serverId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.personal.pool.connect()
    try {
      await client.query('BEGIN')
      if (!(await client.query('SELECT 1 FROM personal_mcp_servers WHERE id=$1 AND user_id=$2 FOR UPDATE', [serverId, userId])).rowCount) throw new PluginError('mcpNotFound', 404)
      const result = await work(client)
      await client.query('UPDATE personal_mcp_servers SET revision=revision+1 WHERE id=$1', [serverId])
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }

  async setTool(userId: string, serverId: string, name: string, enabled: boolean) {
    const toolName = mcpToolName.parse(name)
    if (typeof enabled !== 'boolean') throw new PluginError('invalidPluginInput', 400)
    await this.write(userId, serverId, async client => {
      if (!(await client.query('UPDATE mcp_server_tools SET enabled=$3,updated_at=now() WHERE server_id=$1 AND tool_name=$2 RETURNING tool_name', [serverId, toolName, enabled])).rowCount) throw new PluginError('mcpToolNotFound', 404)
    })
    return this.detail(userId, serverId)
  }

  async setEnvironments(userId: string, serverId: string, raw: z.infer<typeof mcpEnvironmentSettings>) {
    const input = mcpEnvironmentSettings.parse(raw)
    await this.owned(userId, serverId)
    const sharing = new WorkspaceMcpStore(this.personal.pool, this.personal.membership)
    await sharing.workspace(userId, input.workspaceId)
    const members = await this.members()
    const { rows } = await members.query<{ id: string }>('SELECT id FROM workspace_environments WHERE "workspaceId"=$1 AND id=ANY($2::uuid[]) AND "archivedAt" IS NULL', [input.workspaceId, input.environmentIds])
    if (rows.length !== input.environmentIds.length) throw new PluginError('environmentAccessDenied', 403)
    await this.write(userId, serverId, async client => {
      await sharing.workspace(userId, input.workspaceId)
      await client.query('DELETE FROM mcp_server_environments WHERE server_id=$1 AND workspace_id=$2', [serverId, input.workspaceId])
      for (const environmentId of input.environmentIds) await client.query(`INSERT INTO mcp_server_environments(server_id,workspace_id,environment_id) VALUES($1,$2,$3)`, [serverId, input.workspaceId, environmentId])
    })
    return this.detail(userId, serverId, input.workspaceId)
  }

  /** Enumerate all pages before changing the catalogue. A partial failed check
   * never removes the last confirmed tool list or resets a user's switches. */
  async check(userId: string, serverId: string) {
    const installation = await this.owned(userId, serverId)
    if (!installation.enabled) return this.detail(userId, serverId)
    if (installation.transport === 'stdio') throw new PluginError('mcpCheckRequiresDevice', 409)
    const tools: z.infer<typeof pageSchema>['tools'] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    let failureReason: string | null = null
    let status: 'connected' | 'needs_connect' | 'check_failed' = 'connected'
    for (let page = 0; page < 20; page++) {
      const result = await runMcpCommand(async () => {
        const connection = await this.personal.mcpConnection(userId, serverId, installation.revision)
        if (connection.transport === 'stdio') throw new PluginError('mcpCheckRequiresDevice', 409)
        return { url: connection.url, transport: connection.transport, headers: connection.headers, secrets: [...Object.values(connection.headers), connection.url] }
      }, cursor ? { cursor } : {}, this.dependencies, {
        code: error => {
          const failure = mcpFailure(error, 'connect')
          status = failure.status === 401 || error instanceof PluginError && error.code === 'mcpNeedsConnect' ? 'needs_connect' : 'check_failed'
          failureReason = error instanceof PluginError ? error.code : [failure.reason, failure.status].filter(Boolean).join(':')
          return 'mcpUnavailable'
        },
      })
      const parsed = pageSchema.safeParse(result)
      if (!parsed.success) { if (status === 'connected') status = 'check_failed'; failureReason ??= 'invalidToolCatalogue'; break }
      tools.push(...parsed.data.tools)
      if (!parsed.data.nextCursor) break
      if (cursors.has(parsed.data.nextCursor) || page === 19) { status = 'check_failed'; failureReason = 'toolCatalogueIncomplete'; break }
      cursors.add(parsed.data.nextCursor); cursor = parsed.data.nextCursor
    }
    const client = await this.personal.pool.connect()
    try {
      await client.query('BEGIN')
      const { rows: [current] } = await client.query<{ revision: number }>('SELECT revision FROM personal_mcp_servers WHERE id=$1 AND user_id=$2 FOR UPDATE', [serverId, userId])
      if (!current || current.revision !== installation.revision) throw new PluginError('mcpConnectionChanged', 409)
      await client.query('UPDATE personal_mcp_servers SET connection_status=$2,last_checked_at=now(),check_failure=$3 WHERE id=$1', [serverId, status, failureReason])
      if (status === 'connected') {
        await client.query('UPDATE mcp_server_tools SET available=false WHERE server_id=$1', [serverId])
        for (const tool of tools) await client.query(`INSERT INTO mcp_server_tools(server_id,tool_name,description) VALUES($1,$2,$3)
          ON CONFLICT(server_id,tool_name) DO UPDATE SET description=$3,available=true,updated_at=now()`, [serverId, tool.name, (tool.description ?? '').slice(0, 4000)])
      }
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
    const checked = await this.detail(userId, serverId)
    if (checked.status !== 'needs_connect') return checked
    await this.oauth.start(userId, serverId).catch(error => { if (!(error instanceof PluginError)) throw error })
    return this.detail(userId, serverId)
  }
}
