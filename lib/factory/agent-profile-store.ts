import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { digest } from '@/lib/agent-kit/definition'
import { orderCandidates } from '@/lib/model-order'
import { entryKey } from '@/lib/model-order-plan'
import { agentProfileDigest, AgentProfileError, parseAgentProfile, type AgentProfile, type AgentProfileDefinition, type AgentProfileScope, type AgentProfileSkill } from './agent-profile-definition'
import { resolveAgentProfileSkills } from './agent-profile-skills'
import { borrowTaskWorkspaceMembership } from '@/lib/task-workspace'

export type ProfileQuery = Pick<Pool | PoolClient, 'query'>
export interface ProfileRow {
  id: string; ownerId: string; workspaceId: string; version: number; definition: AgentProfileDefinition; skills: AgentProfileSkill[]; digest: string
  createdAt: Date | string; updatedAt: Date | string; archivedAt: Date | string | null
}
export interface ProfileMembership { check(appExecutor?: Pick<PoolClient, 'query'>): Promise<void>; close(): Promise<void> }
export async function acquireProfileMembership(scope: AgentProfileScope): Promise<ProfileMembership> {
  try {
    const borrowed = borrowTaskWorkspaceMembership(scope.ownerId, scope.workspaceId)
    if (borrowed) return {
      async check(appExecutor) {
        try { await borrowed.check(appExecutor) }
        catch (cause) { throw new AgentProfileError('agentProfileScopeNotFound', 404, { cause }) }
      },
      close: () => borrowed.close(),
    }
    const [{ workspacePool }, { acquireWorkspaceMembership }] = await Promise.all([import('@/lib/workspace-db'), import('@/lib/workspace-membership-guard')])
    return await acquireWorkspaceMembership(workspacePool, { workspaceId: scope.workspaceId, userId: scope.ownerId })
  } catch (cause) { throw new AgentProfileError('agentProfileScopeNotFound', 404, { cause }) }
}
export function validateProfileScope(scope: AgentProfileScope) {
  z.string().min(1).max(256).parse(scope.ownerId); z.uuid().parse(scope.workspaceId)
}
const iso = (value: Date | string) => new Date(value).toISOString()
export function profileView(row: ProfileRow): AgentProfile {
  return { ...parseAgentProfile(row.definition), id: row.id, version: row.version, digest: row.digest, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt), archivedAt: row.archivedAt ? iso(row.archivedAt) : null }
}
export async function readProfileRows(query: ProfileQuery, scope: AgentProfileScope) {
  validateProfileScope(scope)
  const { rows } = await query.query<ProfileRow>('SELECT * FROM factory_agent_profiles WHERE "ownerId"=$1 AND "workspaceId"=$2 AND "archivedAt" IS NULL ORDER BY "createdAt",id LIMIT 101', [scope.ownerId, scope.workspaceId])
  return rows
}
export async function readProfileRow(query: ProfileQuery, scope: AgentProfileScope, id: string, lock?: 'share' | 'update') {
  validateProfileScope(scope); z.uuid().parse(id)
  // The lock suffix is a closed host enum, never supplied by HTTP.
  const sql = 'SELECT * FROM factory_agent_profiles WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3' + (lock === 'share' ? ' FOR SHARE' : lock === 'update' ? ' FOR UPDATE' : '')
  const { rows: [row] } = await query.query<ProfileRow>(sql, [id, scope.ownerId, scope.workspaceId])
  if (!row) throw new AgentProfileError('agentProfileNotFound', 404)
  return row
}
async function validateFixedSource(query: ProfileQuery, scope: AgentProfileScope, definition: AgentProfileDefinition) {
  if (definition.model.mode !== 'fixed') return
  const model = definition.model
  if (!(await orderCandidates(query, scope)).some(candidate => entryKey(candidate) === entryKey(model))) throw new AgentProfileError('agentProfileModelUnavailable', 400)
}
/** Immutable versions and an optimistic head; no mutable profile is read by a running native session. */
export class AgentProfileStore {
  constructor(private readonly pool: Pool, private readonly deps: {
    membership?: (scope: AgentProfileScope) => Promise<ProfileMembership>
    validateModel?: (query: ProfileQuery, scope: AgentProfileScope, definition: AgentProfileDefinition) => Promise<void>
  } = {}) {}
  private async transaction<T>(scope: AgentProfileScope, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    validateProfileScope(scope)
    const client = await this.pool.connect(); let member: ProfileMembership | undefined
    try {
      await client.query('BEGIN')
      if (!(await client.query('SELECT id FROM "user" WHERE id=$1 FOR KEY SHARE', [scope.ownerId])).rowCount) throw new AgentProfileError('agentProfileScopeNotFound', 404)
      member = await (this.deps.membership ?? acquireProfileMembership)(scope)
      const result = await operation(client)
      await member.check(client); await client.query('COMMIT'); return result
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
    finally { await member?.close(); client.release() }
  }
  async list(scope: AgentProfileScope) { return this.transaction(scope, async client => (await readProfileRows(client, scope)).map(profileView)) }
  async get(scope: AgentProfileScope, id: string) { return this.transaction(scope, async client => profileView(await readProfileRow(client, scope, id))) }
  async history(scope: AgentProfileScope, id: string) {
    return this.transaction(scope, async client => {
      await readProfileRow(client, scope, id)
      return (await client.query('SELECT version,definition,digest,action,"createdAt" FROM factory_agent_profile_versions WHERE "profileId"=$1 AND "ownerId"=$2 AND "workspaceId"=$3 ORDER BY version DESC LIMIT 100', [id, scope.ownerId, scope.workspaceId])).rows
    })
  }
  private async insertVersion(client: PoolClient, row: ProfileRow, action: 'create' | 'update' | 'archive') {
    await client.query('INSERT INTO factory_agent_profile_versions ("profileId","ownerId","workspaceId",version,definition,skills,digest,action) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [row.id, row.ownerId, row.workspaceId, row.version, JSON.stringify(row.definition), JSON.stringify(row.skills), row.digest, action])
  }
  async create(scope: AgentProfileScope, input: unknown, requestId?: string) {
    const definition = parseAgentProfile(input), skills = resolveAgentProfileSkills(definition.skills), hash = agentProfileDigest(definition, skills)
    const id = requestId ? z.uuid().parse(requestId) : randomUUID()
    return this.transaction(scope, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`factory-profiles:${scope.ownerId}:${scope.workspaceId}`])
      if (requestId) {
        const { rows: [existing] } = await client.query<ProfileRow>('SELECT * FROM factory_agent_profiles WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3', [id, scope.ownerId, scope.workspaceId])
        if (existing) {
          if (existing.digest !== hash || existing.version !== 1 || existing.archivedAt) throw new AgentProfileError('agentProfileRequestConflict')
          return profileView(existing)
        }
      }
      if ((await readProfileRows(client, scope)).length >= 100) throw new AgentProfileError('agentProfileLimit', 400)
      await (this.deps.validateModel ?? validateFixedSource)(client, scope, definition)
      const { rows: [row] } = await client.query<ProfileRow>('INSERT INTO factory_agent_profiles (id,"ownerId","workspaceId",version,definition,skills,digest) VALUES ($1,$2,$3,1,$4,$5,$6) RETURNING *', [id, scope.ownerId, scope.workspaceId, JSON.stringify(definition), JSON.stringify(skills), hash])
      await this.insertVersion(client, row, 'create'); return profileView(row)
    })
  }
  async update(scope: AgentProfileScope, id: string, version: number, input: unknown) {
    const definition = parseAgentProfile(input), skills = resolveAgentProfileSkills(definition.skills)
    z.number().int().positive().parse(version)
    return this.transaction(scope, async client => {
      const current = await readProfileRow(client, scope, id, 'update')
      if (current.archivedAt) throw new AgentProfileError('agentProfileArchived')
      if (current.version !== version) throw new AgentProfileError('agentProfileVersionConflict')
      // A disconnected old source must not prevent disabling its profile.
      if (definition.enabled || digest(definition.model) !== digest(current.definition.model)) await (this.deps.validateModel ?? validateFixedSource)(client, scope, definition)
      const { rows: [row] } = await client.query<ProfileRow>('UPDATE factory_agent_profiles SET version=version+1,definition=$4,skills=$5,digest=$6,"updatedAt"=now() WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3 RETURNING *', [id, scope.ownerId, scope.workspaceId, JSON.stringify(definition), JSON.stringify(skills), agentProfileDigest(definition, skills)])
      await this.insertVersion(client, row, 'update'); return profileView(row)
    })
  }
  async archive(scope: AgentProfileScope, id: string, version: number) {
    z.number().int().positive().parse(version)
    return this.transaction(scope, async client => {
      const current = await readProfileRow(client, scope, id, 'update')
      if (current.version !== version) throw new AgentProfileError('agentProfileVersionConflict')
      if (current.archivedAt) return profileView(current)
      const definition = { ...parseAgentProfile(current.definition), enabled: false }
      const { rows: [row] } = await client.query<ProfileRow>('UPDATE factory_agent_profiles SET version=version+1,definition=$4,digest=$5,"archivedAt"=now(),"updatedAt"=now() WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3 RETURNING *', [id, scope.ownerId, scope.workspaceId, JSON.stringify(definition), agentProfileDigest(definition, current.skills)])
      await this.insertVersion(client, row, 'archive'); return profileView(row)
    })
  }
}
