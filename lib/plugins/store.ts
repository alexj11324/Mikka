import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { openSecret, sealSecret, type Sealed } from '@/lib/secrets/crypto'
import { PluginError, type InstalledSkill, type McpServerView, type PersonalPluginSnapshot, type SkillContent, type createMcpSchema, type updateMcpSchema } from './contracts'
import type { z } from 'zod'
import { taskMcpServerSchema, type TaskMcpServer } from '../../packages/protocol/src/task-mcp'
import type { McpAuthority } from './contracts'
import { singleMcpAuthority, WorkspaceMcpStore } from './workspace-mcp'

type McpRow = Omit<McpServerView, 'authKind' | 'createdAt'> & {
  auth_header: string | null; ciphertext: string | null; iv: string | null; key_version: number | null; created_at: Date; oauth_enabled: boolean;
}
const mcpColumns = 'id,name,url,transport,enabled,revision,auth_header,ciphertext,iv,key_version,created_at,oauth_enabled'
const skillColumns = 'id,name,source,slug,source_kind AS "sourceKind",source_revision AS "sourceRevision",source_path AS "sourcePath",sha256,enabled,created_at AS "createdAt"'
const mcpView = (row: McpRow): McpServerView => ({ id: row.id, name: row.name, url: row.url, transport: row.transport, enabled: row.enabled, revision: row.revision, authKind: row.oauth_enabled ? 'oauth' : row.transport === 'stdio' ? 'env' : row.auth_header ? 'header' : 'none', createdAt: row.created_at.toISOString() })
const aad = (userId: string, id: string, url: string, header: string) => JSON.stringify(['personal-mcp', userId, id, url, header.toLowerCase()])

export class PersonalPluginStore {
  constructor(readonly pool: Pool, readonly env: Record<string, string | undefined> = process.env, readonly membership?: Pick<Pool | PoolClient, 'query'>) {}
  private async write<T>(userId: string, work: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`personal-plugins:${userId}`])
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }
  async listMcp(userId: string): Promise<McpServerView[]> {
    return (await this.pool.query<McpRow>(`SELECT ${mcpColumns} FROM personal_mcp_servers WHERE user_id=$1 ORDER BY created_at,id`, [userId])).rows.map(mcpView)
  }
  async createMcp(userId: string, input: z.infer<typeof createMcpSchema>) {
    const id = randomUUID(), url = input.transport === 'stdio' ? '' : input.url
    const header = input.transport === 'stdio' ? '__stdio__' : input.headers ? '__headers__' : input.auth?.name.toLowerCase() ?? null
    const value = input.transport === 'stdio' ? JSON.stringify({ command: input.command, args: input.args, cwd: input.cwd, env: input.env }) : input.headers ? JSON.stringify(input.headers) : input.auth?.value
    const sealed = value !== undefined ? sealSecret(value, aad(userId, id, url, header!), this.env) : null
    return this.write(userId, async client => {
      if ((await client.query('SELECT 1 FROM personal_mcp_servers WHERE user_id=$1', [userId])).rowCount! >= 20) throw new PluginError('mcpLimitReached', 409)
      const { rows } = await client.query<McpRow>(`INSERT INTO personal_mcp_servers(id,user_id,name,url,transport,enabled,auth_header,ciphertext,iv,key_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${mcpColumns}`, [id, userId, input.name, url, input.transport, input.enabled, header, sealed?.ciphertext ?? null, sealed?.iv ?? null, sealed?.keyVersion ?? null])
      return mcpView(rows[0])
    })
  }
  async updateMcp(userId: string, input: z.infer<typeof updateMcpSchema>) {
    return this.write(userId, async client => {
      const row = (await client.query<McpRow>(`SELECT ${mcpColumns} FROM personal_mcp_servers WHERE id=$1 AND user_id=$2 FOR UPDATE`, [input.id, userId])).rows[0]
      if (!row) throw new PluginError('mcpNotFound', 404)
      if (row.transport === 'stdio' ? input.auth !== undefined || input.headers !== undefined : input.env !== undefined) throw new PluginError('invalidPluginInput', 400)
      let header = row.auth_header
      let sealed: Sealed | null = row.ciphertext ? { ciphertext: row.ciphertext, iv: row.iv!, keyVersion: row.key_version! } : null
      if (row.transport === 'stdio' && input.env !== undefined) {
        const value = JSON.parse(openSecret(sealed!, aad(userId,row.id,row.url,header!),this.env))
        sealed = sealSecret(JSON.stringify({ ...value, env: input.env }), aad(userId,row.id,row.url,header!),this.env)
      } else if (input.headers !== undefined || input.auth !== undefined) {
        header = input.headers ? '__headers__' : input.auth?.name.toLowerCase() ?? null
        const value = input.headers ? JSON.stringify(input.headers) : input.auth?.value
        sealed = value === undefined ? null : sealSecret(value, aad(userId,row.id,row.url,header!),this.env)
      }
      const name = input.name ?? row.name
      const enabled = input.enabled ?? row.enabled
      // Keep already-admitted credential-free references valid when disconnect is retried.
      if ((input.auth === null || input.headers === null) && row.auth_header === null
        && !row.oauth_enabled && name === row.name && enabled === row.enabled) return mcpView(row)
      const { rows } = await client.query<McpRow>(`UPDATE personal_mcp_servers SET name=$3,enabled=$4,auth_header=$5,ciphertext=$6,iv=$7,key_version=$8,oauth_enabled=CASE WHEN $9 THEN false ELSE oauth_enabled END,revision=revision+1 WHERE id=$1 AND user_id=$2 RETURNING ${mcpColumns}`, [row.id, userId, name, enabled, header, sealed?.ciphertext ?? null, sealed?.iv ?? null, sealed?.keyVersion ?? null, input.auth !== undefined || input.headers !== undefined])
      return mcpView(rows[0])
    })
  }
  async deleteMcp(userId: string, id: string) {
    if (!(await this.pool.query('DELETE FROM personal_mcp_servers WHERE id=$1 AND user_id=$2', [id, userId])).rowCount) throw new PluginError('mcpNotFound', 404)
  }
  /** Called immediately before remote discovery/call. Never returned by an API. */
  async mcpConnection(userId: string, id: string, revision?: number, authority?: McpAuthority) {
    const grant = authority ? (await new WorkspaceMcpStore(this.pool, this.membership).validate(userId, singleMcpAuthority(authority, id))).servers[0] : null
    const ownerId = grant?.ownerId ?? userId
    const row = (await this.pool.query<McpRow>(`SELECT ${mcpColumns} FROM personal_mcp_servers WHERE id=$1 AND user_id=$2 AND enabled=true`, [id, ownerId])).rows[0]
    if (!row || revision !== undefined && row.revision !== revision) throw new PluginError('mcpUnavailable', 404)
    if (grant && row.revision !== grant.revision) throw new PluginError('mcpUnavailable', 404)
    const value = row.auth_header && !row.oauth_enabled ? openSecret({ ciphertext: row.ciphertext!, iv: row.iv!, keyVersion: row.key_version! }, aad(ownerId,row.id,row.url,row.auth_header),this.env) : null
    const native = row.transport === 'stdio' ? taskMcpServerSchema.parse({ name: `mcp_${row.id.replaceAll('-','')}`, transport: 'stdio', ...JSON.parse(value!) }) : undefined
    const headers: Record<string,string> = row.oauth_enabled ? { Authorization: `Bearer ${await new (await import('./mcp-oauth')).McpOAuthStore(this.pool, this.env).accessToken(ownerId, id)}` } : row.auth_header === '__headers__' ? JSON.parse(value!) : row.auth_header && row.transport !== 'stdio' ? { [row.auth_header]:value! } : {}
    const { rows: disabled } = await this.pool.query<{ name: string }>('SELECT tool_name AS name FROM mcp_server_tools WHERE server_id=$1 AND NOT enabled ORDER BY tool_name', [id])
    const disabledTools = disabled.map(tool => tool.name)
    return { ...mcpView(row), headers, disabledTools, ...(native ? { native: { ...native, ...(disabledTools.length ? { disabledTools } : {}) } } : {}) }
  }
  /** One admission-time export to the authorized task/eve runtime. No secret enters its snapshot. */
  async nativeMcpConnections(userId: string, authority: McpAuthority, environmentId?: string | null): Promise<TaskMcpServer[]> {
    const authorized = await new WorkspaceMcpStore(this.pool,this.membership).validate(userId,environmentId === undefined ? authority : { ...authority, environmentId })
    return Promise.all(authorized.servers.map(async grant => {
      const connection = await this.mcpConnection(userId,grant.id,grant.revision,authorized)
      return connection.native ?? taskMcpServerSchema.parse({ name:`mcp_${grant.id.replaceAll('-','')}`, transport:connection.transport,url:connection.url,headers:connection.headers,...(connection.disabledTools.length ? { disabledTools:connection.disabledTools } : {}) })
    }))
  }

  async listSkills(userId: string): Promise<InstalledSkill[]> {
    return (await this.pool.query<InstalledSkill>(`SELECT ${skillColumns} FROM personal_skills WHERE user_id=$1 ORDER BY created_at,id`, [userId])).rows
  }
  async getSkill(userId: string, id: string): Promise<InstalledSkill> {
    const { rows: [skill] } = await this.pool.query<InstalledSkill>(
      `SELECT ${skillColumns} FROM personal_skills WHERE user_id=$1 AND id=$2`, [userId, id],
    )
    if (!skill) throw new PluginError('skillNotFound', 404)
    return skill
  }
  async installSkill(userId: string, skill: SkillContent) {
    return this.write(userId, async client => {
      const existing = (await client.query<InstalledSkill>(`SELECT ${skillColumns} FROM personal_skills WHERE user_id=$1 AND source=$2 AND slug=$3`, [userId, skill.source, skill.slug])).rows[0]
      if (existing) return existing
      const usage = (await client.query<{ count: number; bytes: number }>('SELECT count(*)::int AS count,COALESCE(sum(octet_length(body)),0)::int AS bytes FROM personal_skills WHERE user_id=$1', [userId])).rows[0]
      if (usage.count >= 20 || usage.bytes + Buffer.byteLength(skill.body) > 100_000) throw new PluginError('skillLimitReached', 409)
      const { rows } = await client.query<InstalledSkill>(`INSERT INTO personal_skills(id,user_id,name,source,slug,source_kind,source_revision,source_path,body,sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${skillColumns}`, [randomUUID(), userId, skill.name, skill.source, skill.slug, skill.sourceKind, skill.sourceRevision, skill.sourcePath, skill.body, skill.sha256])
      return rows[0]
    })
  }
  async updateSkill(userId: string, id: string, enabled: boolean) {
    const row = (await this.pool.query<InstalledSkill>(`UPDATE personal_skills SET enabled=$3 WHERE id=$1 AND user_id=$2 RETURNING ${skillColumns}`, [id, userId, enabled])).rows[0]
    if (!row) throw new PluginError('skillNotFound', 404)
    return row
  }
  async deleteSkill(userId: string, id: string) {
    if (!(await this.pool.query('DELETE FROM personal_skills WHERE id=$1 AND user_id=$2', [id, userId])).rowCount) throw new PluginError('skillNotFound', 404)
  }
  /** Resolve the bot's existing runtime environment before freezing connection scope. */
  async snapshotForBot(userId: string, botId: string | null, workspaceId: string | null, client: Pick<PoolClient, 'query'> = this.pool) {
    const { rows: [bot] } = botId ? await client.query<{ environmentId: string | null }>('SELECT "environmentId" FROM bots WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3', [botId, userId, workspaceId]) : { rows: [] }
    return this.snapshot(userId, client, workspaceId, bot?.environmentId)
  }
  /**
   * One enabled skill's body, for `read_personal_skill` (ALE-75).
   *
   * Read from the table rather than from the execution snapshot on purpose:
   * the snapshot's skill list is frozen when the round begins, so it answers
   * "which skills did this round start with". A fetch is a read of the
   * person's current installation, and a skill they switched off mid-turn
   * must not still hand its body over. `enabled=true` and the owner check in
   * one statement, so a body is never served for another person's row.
   */
  async readSkillBody(userId: string, id: string): Promise<{ id: string; name: string; body: string } | null> {
    const row = (await this.pool.query<{ id: string; name: string; body: string }>(
      'SELECT id,name,body FROM personal_skills WHERE id=$1 AND user_id=$2 AND enabled=true', [id, userId])).rows[0]
    return row ?? null
  }
  async snapshot(userId: string, client: Pick<PoolClient, 'query'> = this.pool, workspaceId?: string | null, environmentId?: string | null): Promise<PersonalPluginSnapshot> {
    const mcpAuthority = workspaceId ? await new WorkspaceMcpStore(this.pool, this.membership).freeze(userId, workspaceId, client, environmentId) : undefined
    const servers = mcpAuthority ? mcpAuthority.servers.map(({ id, name, revision }) => ({ id, name, revision }))
      : (await client.query<PersonalPluginSnapshot['servers'][number]>('SELECT id,name,revision FROM personal_mcp_servers WHERE user_id=$1 AND enabled=true AND NOT EXISTS (SELECT 1 FROM mcp_server_environments b WHERE b.server_id=personal_mcp_servers.id) ORDER BY created_at,id', [userId])).rows
    const skills = (await client.query<PersonalPluginSnapshot['skills'][number]>(`SELECT id,name,source,slug,source_kind AS "sourceKind",source_revision AS "sourceRevision",source_path AS "sourcePath",sha256,body FROM personal_skills WHERE user_id=$1 AND enabled=true ORDER BY created_at,id`, [userId])).rows
    const accounts = (await client.query<{ toolkit: string }>('SELECT DISTINCT toolkit FROM composio_accounts WHERE "userId"=$1 AND toolkit=\'googledrive\'', [userId])).rows
    return { servers, skills, toolkits: accounts.map(row => row.toolkit), ...(mcpAuthority ? { mcpAuthority } : {}) }
  }
}
