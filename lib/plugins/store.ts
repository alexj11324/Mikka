import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { openSecret, sealSecret, type Sealed } from '@/lib/secrets/crypto'
import { PluginError, type InstalledSkill, type McpServerView, type PersonalPluginSnapshot, type SkillContent, type createMcpSchema, type updateMcpSchema } from './contracts'
import type { z } from 'zod'
import type { McpAuthority } from './contracts'
import { singleMcpAuthority, WorkspaceMcpStore } from './workspace-mcp'

type McpRow = Omit<McpServerView, 'authKind' | 'createdAt'> & {
  auth_header: string | null; ciphertext: string | null; iv: string | null; key_version: number | null; created_at: Date;
}
const mcpColumns = 'id,name,url,transport,enabled,revision,auth_header,ciphertext,iv,key_version,created_at'
const skillColumns = 'id,name,source,slug,source_kind AS "sourceKind",source_revision AS "sourceRevision",source_path AS "sourcePath",sha256,enabled,created_at AS "createdAt"'
const mcpView = (row: McpRow): McpServerView => ({ id: row.id, name: row.name, url: row.url, transport: row.transport, enabled: row.enabled, revision: row.revision, authKind: row.auth_header ? 'header' : 'none', createdAt: row.created_at.toISOString() })
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
    const id = randomUUID(), header = input.auth?.name.toLowerCase() ?? null
    const sealed = input.auth ? sealSecret(input.auth.value, aad(userId, id, input.url, header!), this.env) : null
    return this.write(userId, async client => {
      if ((await client.query('SELECT 1 FROM personal_mcp_servers WHERE user_id=$1', [userId])).rowCount! >= 20) throw new PluginError('mcpLimitReached', 409)
      const { rows } = await client.query<McpRow>(`INSERT INTO personal_mcp_servers(id,user_id,name,url,transport,enabled,auth_header,ciphertext,iv,key_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${mcpColumns}`, [id, userId, input.name, input.url, input.transport, input.enabled, header, sealed?.ciphertext ?? null, sealed?.iv ?? null, sealed?.keyVersion ?? null])
      return mcpView(rows[0])
    })
  }
  async updateMcp(userId: string, input: z.infer<typeof updateMcpSchema>) {
    return this.write(userId, async client => {
      const row = (await client.query<McpRow>(`SELECT ${mcpColumns} FROM personal_mcp_servers WHERE id=$1 AND user_id=$2 FOR UPDATE`, [input.id, userId])).rows[0]
      if (!row) throw new PluginError('mcpNotFound', 404)
      const header = input.auth === undefined ? row.auth_header : input.auth?.name.toLowerCase() ?? null
      const sealed: Sealed | null = input.auth === undefined ? row.ciphertext ? { ciphertext: row.ciphertext, iv: row.iv!, keyVersion: row.key_version! } : null
        : input.auth ? sealSecret(input.auth.value, aad(userId, row.id, row.url, header!), this.env) : null
      const { rows } = await client.query<McpRow>(`UPDATE personal_mcp_servers SET name=$3,enabled=$4,auth_header=$5,ciphertext=$6,iv=$7,key_version=$8,revision=revision+1 WHERE id=$1 AND user_id=$2 RETURNING ${mcpColumns}`, [row.id, userId, input.name ?? row.name, input.enabled ?? row.enabled, header, sealed?.ciphertext ?? null, sealed?.iv ?? null, sealed?.keyVersion ?? null])
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
    const headers = row.auth_header ? { [row.auth_header]: openSecret({ ciphertext: row.ciphertext!, iv: row.iv!, keyVersion: row.key_version! }, aad(ownerId, row.id, row.url, row.auth_header), this.env) } : {}
    return { ...mcpView(row), headers }
  }
  async listSkills(userId: string): Promise<InstalledSkill[]> {
    return (await this.pool.query<InstalledSkill>(`SELECT ${skillColumns} FROM personal_skills WHERE user_id=$1 ORDER BY created_at,id`, [userId])).rows
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
  async snapshot(userId: string, client: Pick<PoolClient, 'query'> = this.pool, workspaceId?: string | null): Promise<PersonalPluginSnapshot> {
    const mcpAuthority = workspaceId ? await new WorkspaceMcpStore(this.pool, this.membership).freeze(userId, workspaceId, client) : undefined
    const servers = mcpAuthority ? mcpAuthority.servers.map(({ id, name, revision }) => ({ id, name, revision }))
      : (await client.query<PersonalPluginSnapshot['servers'][number]>('SELECT id,name,revision FROM personal_mcp_servers WHERE user_id=$1 AND enabled=true ORDER BY created_at,id', [userId])).rows
    const skills = (await client.query<PersonalPluginSnapshot['skills'][number]>(`SELECT id,name,source,slug,source_kind AS "sourceKind",source_revision AS "sourceRevision",source_path AS "sourcePath",sha256,body FROM personal_skills WHERE user_id=$1 AND enabled=true ORDER BY created_at,id`, [userId])).rows
    const accounts = (await client.query<{ toolkit: string }>('SELECT DISTINCT toolkit FROM composio_accounts WHERE "userId"=$1 AND toolkit=\'googledrive\'', [userId])).rows
    return { servers, skills, toolkits: accounts.map(row => row.toolkit), ...(mcpAuthority ? { mcpAuthority } : {}) }
  }
}
