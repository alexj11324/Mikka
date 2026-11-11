import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { PluginError } from './contracts'
import { skillDescription } from './skill-metadata'
import { assertOrganizationResourceShare, organizationResourceAllowed, workspaceResourcePolicy } from '@/lib/governance/resource-access'

type Query = Pick<Pool | PoolClient, 'query'>
type Workspace = { id: string; kind: 'personal' | 'team'; name: string }
type Row = {
  id: string; ownerId: string; name: string; slug: string; source: string; sourceKind: string; sourceRevision: string
  enabled: boolean; body: string; sha256: string; shareId: string | null
}
export type WorkspaceSkillView = {
  id: string; name: string; description: string; slug: string; source: string; sourceKind: string; sourceRevision: string
  enabled: boolean; ownerId: string; ownerName: string | null; mine: boolean; shared: boolean
}
export type WorkspaceSkillPage = {
  workspaceId: string; workspaceKind: 'personal' | 'team'; canShare: boolean; skills: WorkspaceSkillView[]; count: number
}
export const shareSkillSchema = z.object({ workspaceId: z.uuid(), skillId: z.uuid(), shared: z.boolean() }).strict()
const SHARED_COLUMNS = `s.id,s.user_id AS "ownerId",s.name,s.slug,s.source,s.source_kind AS "sourceKind",
  s.source_revision AS "sourceRevision",s.enabled,s.body,s.sha256,g.id AS "shareId"`

async function workspaceMember(query: Query, userId: string, workspaceId: string): Promise<Workspace> {
  const { rows: [row] } = await query.query<Workspace>(`SELECT w.id,w.kind,m.name FROM mikka_workspaces w
    JOIN mikka_workspace_members m ON m."workspaceId"=w.id AND m."userId"=$2 AND m.status='active'
    WHERE w.id=$1`, [workspaceId, userId])
  if (!row) throw new PluginError('workspaceAccessDenied', 403)
  return row
}

/** Explicit owner grants over personal Skills, mirroring MCP workspace shares:
 * a personal workspace has nothing to share to, and a member sees only public
 * metadata (never the body) of someone else's shared Skill. */
export class WorkspaceSkillStore {
  constructor(readonly pool: Pool, readonly membership?: Query) {}

  private async members() { return this.membership ?? (await import('@/lib/workspace-db')).workspacePool }

  async workspace(userId: string, workspaceId: string): Promise<Workspace> {
    return workspaceMember(await this.members(), userId, workspaceId)
  }

  private async activeNames(workspaceId: string, userIds: readonly string[]) {
    const { rows } = await (await this.members()).query<{ userId: string; name: string }>(`SELECT "userId",name FROM mikka_workspace_members
      WHERE "workspaceId"=$1 AND "userId"=ANY($2::text[]) AND status='active'`, [workspaceId, [...new Set(userIds)]])
    return new Map(rows.map(row => [row.userId, row.name]))
  }

  async list(userId: string, workspaceId: string): Promise<WorkspaceSkillPage> {
    const workspace = await this.workspace(userId, workspaceId)
    const { rows } = await this.pool.query<Row>(`SELECT ${SHARED_COLUMNS} FROM personal_skills s
      LEFT JOIN personal_skill_workspace_shares g ON g.skill_id=s.id AND g.workspace_id=$2
      WHERE s.user_id=$1 OR ($3::boolean AND g.id IS NOT NULL)
      ORDER BY (s.user_id=$1) DESC,s.created_at,s.id`, [userId, workspaceId, workspace.kind === 'team'])
    const names = await this.activeNames(workspaceId, [userId, ...rows.map(row => row.ownerId)])
    const members = await this.members()
    const allowed = await Promise.all(rows.map(row => row.ownerId === userId ? true : organizationResourceAllowed(workspaceId, 'skill', row.id, row.ownerId, members)))
    const policy = await workspaceResourcePolicy(workspaceId, members)
    const skills = rows.filter((row, index) => row.ownerId === userId || (allowed[index] && names.has(row.ownerId))).map(row => ({
      id: row.id, name: row.name, description: skillDescription(row.body, row.name), slug: row.slug, source: row.source,
      sourceKind: row.sourceKind, sourceRevision: row.sourceRevision, enabled: row.enabled, ownerId: row.ownerId,
      ownerName: names.get(row.ownerId) ?? null, mine: row.ownerId === userId, shared: Boolean(row.shareId),
    }))
    return { workspaceId, workspaceKind: workspace.kind, canShare: workspace.kind === 'team' && policy.mcpSharing !== 'deny', skills, count: skills.length }
  }

  async share(userId: string, input: z.infer<typeof shareSkillSchema>): Promise<WorkspaceSkillPage> {
    const parsed = shareSkillSchema.parse(input)
    if ((await this.workspace(userId, parsed.workspaceId)).kind !== 'team') throw new PluginError('workspaceAccessDenied', 403)
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const locked = await client.query('SELECT 1 FROM personal_skills WHERE id=$1 AND user_id=$2 FOR UPDATE', [parsed.skillId, userId])
      if (!locked.rowCount) throw new PluginError('skillNotFound', 404)
      if (parsed.shared) await assertOrganizationResourceShare(parsed.workspaceId, 'skill', parsed.skillId, userId, await this.members())
      if (parsed.shared) await client.query(`INSERT INTO personal_skill_workspace_shares(id,skill_id,workspace_id)
        VALUES($1,$2,$3) ON CONFLICT(skill_id,workspace_id) DO NOTHING`, [randomUUID(), parsed.skillId, parsed.workspaceId])
      else await client.query('DELETE FROM personal_skill_workspace_shares WHERE skill_id=$1 AND workspace_id=$2', [parsed.skillId, parsed.workspaceId])
      // Membership lives in a separate database. Recheck after lock waits;
      // every Profile save, dispatch and claim checks it again live.
      await this.workspace(userId, parsed.workspaceId)
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    return this.list(userId, parsed.workspaceId)
  }
}
