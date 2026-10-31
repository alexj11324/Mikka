import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { skillArtifactRefSchema, skillMarkdown, type SkillArtifactRef } from '@mikka/protocol/skill'
import { db, withDatabaseClient } from '@/lib/db'
import { workspacePool } from '@/lib/workspace-db'
import { recordAudit } from '@/lib/audit/record'
import { realCliMembershipGuard, lockCliTaskScope } from '@/lib/agent-tool-approval/policy-store'
import { writeTransaction } from '@/lib/operations/write-transaction'
import { UNFINISHED_RUN_STATUSES } from '@/lib/agent-run-statuses'
import { recordCoordinatorEvent } from '@/lib/coordinator-event-store'
import { runFinishedEvent } from '@/lib/coordinator-events'
import { afterRunEnded } from '@/lib/run-completion-effects'
import { digest, ImprovementError } from './contract'
import { resolveTeamSkillContent, teamSkillArtifact, teamSkillUploadSchema, teamSkillManifestSchema, type TeamSkillMetadata } from './team-skill-contract'

export interface TeamSkillScope { workspaceId: string; userId: string }
const manifest = { format: 'single-skill-md-v1' as const, dependencies: [] as [], permissions: [] as [] }
const versionIdSchema = z.uuid()
const reviewSchema = z.strictObject({ versionId: z.uuid(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
async function teamRole(scope: TeamSkillScope, admin = false) {
  if (!versionIdSchema.safeParse(scope.workspaceId).success || !scope.userId) throw new ImprovementError('notFound')
  const { rows: [member] } = await workspacePool.query(`SELECT role FROM mikka_workspace_members
    WHERE "workspaceId"=$1 AND "userId"=$2 AND status='active'`, [scope.workspaceId, scope.userId])
  if (!member || (admin && member.role !== 'admin')) throw new ImprovementError('notFound')
}
function guard(scope: TeamSkillScope, admin = false) {
  return async (_tx: PoolClient, signal: AbortSignal) => {
    const lease = await realCliMembershipGuard(scope.workspaceId, scope.userId, signal)
    try {
      if (admin) {
        const role = await lease.workspaceClient!.query(`SELECT role FROM mikka_workspace_members
          WHERE "workspaceId"=$1 AND "userId"=$2 AND status='active' FOR SHARE`, [scope.workspaceId, scope.userId])
        if (role.rows[0]?.role !== 'admin') throw new ImprovementError('notFound')
      }
      return lease
    } catch (error) { await lease.close(); throw error }
  }
}
export function teamSkillMembershipGuard(userId: string, versionId: string) {
  return async (tx: PoolClient, signal: AbortSignal) => {
    const {rows:[metadata]}=await tx.query<{workspaceId:string}>('SELECT "workspaceId" FROM improvement_team_skill_metadata WHERE "versionId"=$1',[versionId])
    if(!metadata)throw new ImprovementError('notFound')
    return guard({workspaceId:metadata.workspaceId,userId})(tx,signal)
  }
}
async function lockTeamVersion(tx: PoolClient, versionId: string) {
  if (!versionIdSchema.safeParse(versionId).success) throw new ImprovementError('notFound')
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`team-skill-version:${versionId}`])
}
async function readVersion(tx: PoolClient, workspaceId: string, versionId: string, allowPending = false) {
  const { rows: [row] } = await tx.query<TeamSkillMetadata & { artifact: unknown; markdown: string }>(`SELECT m.*,v.artifact,v.markdown
    FROM improvement_team_skill_metadata m JOIN improvement_skill_versions v ON v.id=m."versionId"
    WHERE m."versionId"=$1 AND m."workspaceId"=$2`, [versionId, workspaceId])
  if (!row) throw new ImprovementError('notFound')
  const artifact = skillArtifactRefSchema.safeParse(row.artifact)
  if (!artifact.success || artifact.data.registryId !== 'mikka-team' || artifact.data.versionId !== row.versionId ||
    row.source !== 'workspace-upload' || !teamSkillManifestSchema.safeParse(row.manifest).success)
    throw new ImprovementError('sourceMismatch')
  const skill = resolveTeamSkillContent(row, artifact.data, row.markdown)
  const { rows: reviews } = await tx.query<{ operation: 'approve' | 'withdraw'; sha256: string }>(`SELECT operation,sha256
    FROM improvement_team_skill_reviews WHERE "versionId"=$1 AND "workspaceId"=$2`, [versionId, workspaceId])
  if (reviews.some(review => review.sha256 !== artifact.data.sha256)) throw new ImprovementError('sourceMismatch')
  const withdrawn = reviews.some(review => review.operation === 'withdraw')
  const approved = reviews.some(review => review.operation === 'approve')
  if (!allowPending && withdrawn) throw new ImprovementError('runUnavailable')
  if (!allowPending && !approved) throw new ImprovementError('sourceRequired')
  const { artifact: _artifact, markdown: _markdown, ...metadata } = row
  return { artifact: artifact.data, markdown: row.markdown, skill, metadata, status: withdrawn ? 'withdrawn' : approved ? 'approved' : 'pending' }
}

/** Derive namespace from the stored run and task, never a registry request field. */
export async function teamSkillRunScope(tx: PoolClient, userId: string, run: { id?: string; issueId: string; agentId: string; deviceRepoId: string }) {
  if (!run.id) throw new ImprovementError('sourceMismatch')
  const { rows: [source] } = await tx.query<{ botId: string | null }>(`SELECT "botId" FROM agent_runs
    WHERE id=$1 AND "userId"=$2 AND "issueId"=$3 AND "agentId"=$4 AND "deviceRepoId"=$5 FOR SHARE`,
  [run.id, userId, run.issueId, run.agentId, run.deviceRepoId])
  if (!source) throw new ImprovementError('notFound')
  let task: Awaited<ReturnType<typeof lockCliTaskScope>>
  try { task = await lockCliTaskScope(tx, userId, run.issueId) }
  catch { throw new ImprovementError('notFound') }
  const { rows: [bot] } = source.botId ? await tx.query<{ workspaceId: string }>(`SELECT "workspaceId" FROM bots
    WHERE id=$1 AND "ownerId"=$2 FOR SHARE`, [source.botId, userId]) : { rows: [] }
  if (source.botId && !bot) throw new ImprovementError('notFound')
  const workspaces = [...new Set([bot?.workspaceId, task.workspaceId].filter((id): id is string => !!id))]
  if (workspaces.length !== 1) throw new ImprovementError('sourceMismatch')
  const scope = { workspaceId: workspaces[0], userId }
  await teamRole(scope)
  return scope
}
export async function resolveTeamRunSkill(tx: PoolClient, userId: string,
  run: { id?: string; issueId: string; agentId: string; deviceRepoId: string }, artifact: SkillArtifactRef) {
  const scope = await teamSkillRunScope(tx, userId, run)
  await lockTeamVersion(tx, artifact.versionId)
  const version = await readVersion(tx, scope.workspaceId, artifact.versionId)
  if (digest(version.artifact) !== digest(artifact)) throw new ImprovementError('sourceMismatch')
  return { artifact: version.artifact, markdown: version.markdown, skill: version.skill, metadata: null }
}

export class TeamSkillStore {
  constructor(readonly pool: Pick<Pool, 'connect'>) {}
  async list(scope: TeamSkillScope, inspect=false) {
    await teamRole(scope,inspect)
    return writeTransaction(this.pool,async tx=>{
      const {rows}=await tx.query(`SELECT m."versionId",m."skillId",m."catalogOwnerId",m.name,m.description,m.license,m.source,m."createdAt",v.artifact,
        EXISTS(SELECT 1 FROM improvement_team_skill_reviews r WHERE r."versionId"=m."versionId" AND r.operation='withdraw') AS withdrawn,
        EXISTS(SELECT 1 FROM improvement_team_skill_reviews r WHERE r."versionId"=m."versionId" AND r.operation='approve') AS approved
        FROM improvement_team_skill_metadata m JOIN improvement_skill_versions v ON v.id=m."versionId"
        WHERE m."workspaceId"=$1 AND ($2 OR (EXISTS(SELECT 1 FROM improvement_team_skill_reviews r WHERE r."versionId"=m."versionId" AND r.operation='approve')
          AND NOT EXISTS(SELECT 1 FROM improvement_team_skill_reviews r WHERE r."versionId"=m."versionId" AND r.operation='withdraw')))
        ORDER BY m."createdAt" DESC,m."versionId" LIMIT 100`,[scope.workspaceId,inspect])
      return rows.map(({approved,withdrawn,...row})=>({...row,status:withdrawn?'withdrawn':approved?'approved':'pending'}))
    },{guard:guard(scope,inspect)})
  }
  async register(scope: TeamSkillScope, input: unknown) {
    await teamRole(scope, true)
    const parsed = teamSkillUploadSchema.safeParse(input)
    if (!parsed.success) throw new ImprovementError('invalid')
    return writeTransaction(this.pool, async tx => {
      const value = parsed.data
      let catalogOwnerId = scope.userId
      if (value.skillId) {
        const { rows: [catalog] } = await tx.query<TeamSkillMetadata>(`SELECT * FROM improvement_team_skill_metadata
          WHERE "workspaceId"=$1 AND "skillId"=$2 ORDER BY "createdAt" LIMIT 1`, [scope.workspaceId, value.skillId])
        if (!catalog) throw new ImprovementError('notFound')
        catalogOwnerId = catalog.catalogOwnerId
      }
      const skillId = value.skillId ?? randomUUID(), versionId = randomUUID()
      const markdown = skillMarkdown(value), artifact = teamSkillArtifact(versionId, skillId, markdown)
      await tx.query('INSERT INTO improvement_skill_versions(id,artifact,markdown) VALUES($1,$2,$3)', [versionId, artifact, markdown])
      await tx.query(`INSERT INTO improvement_team_skill_metadata("versionId","workspaceId","skillId","catalogOwnerId",
        "submittedBy",name,description,license,manifest,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'workspace-upload')`,
      [versionId, scope.workspaceId, skillId, catalogOwnerId, scope.userId, value.name, value.description, value.license, manifest])
      await withDatabaseClient(tx, () => recordAudit(db, { workspaceId: scope.workspaceId,
        actor: { type: 'user', id: scope.userId, name: scope.userId }, action: 'skill.registered',
        target: { type: 'skill', id: skillId, label: value.name }, metadata: { versionId, sha256: artifact.sha256, format: artifact.format } }))
      return { artifact, status: 'pending' as const }
    }, { guard: guard(scope, true) })
  }
  async read(scope: TeamSkillScope, versionId: string, inspect = false) {
    await teamRole(scope, inspect)
    return writeTransaction(this.pool, async tx => {
      await lockTeamVersion(tx, versionId)
      const version = await readVersion(tx, scope.workspaceId, versionId, inspect)
      return { artifact: version.artifact, metadata: version.metadata, skill: version.skill, status: version.status }
    }, { guard: guard(scope, inspect) })
  }
  async review(scope: TeamSkillScope, input: unknown, operation: 'approve' | 'withdraw') {
    await teamRole(scope, true)
    const parsed = reviewSchema.safeParse(input)
    if (!parsed.success) throw new ImprovementError('invalid')
    const ended: {id:string;userId:string}[]=[]
    const result=await writeTransaction(this.pool, async tx => {
      const { versionId, sha256 } = parsed.data
      const visible = await tx.query(`SELECT 1 FROM improvement_team_skill_metadata WHERE "versionId"=$1 AND "workspaceId"=$2 FOR SHARE`, [versionId, scope.workspaceId])
      if (!visible.rowCount) throw new ImprovementError('notFound')
      if (operation === 'withdraw') {
        // Claims lock issue then run before the Skill. Keep that order before
        // taking the version lock and stopping every selected attempt.
        await tx.query(`SELECT i.id FROM issues i WHERE i.id IN (SELECT r."issueId" FROM agent_runs r
          JOIN improvement_skill_selections s ON s."runId"=r.id WHERE s."versionId"=$1) ORDER BY i.id FOR SHARE`, [versionId])
        await tx.query(`SELECT r.id FROM agent_runs r JOIN improvement_skill_selections s ON s."runId"=r.id
          WHERE s."versionId"=$1 ORDER BY r.id FOR UPDATE OF r`, [versionId])
      }
      await lockTeamVersion(tx, versionId)
      const version = await readVersion(tx, scope.workspaceId, versionId, true)
      if (version.artifact.sha256 !== sha256) throw new ImprovementError('sourceMismatch')
      if (operation === 'approve' && version.status === 'withdrawn') throw new ImprovementError('runUnavailable')
      const inserted = await tx.query(`INSERT INTO improvement_team_skill_reviews(id,"versionId","workspaceId","reviewerId",operation,sha256)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT("versionId",operation) DO NOTHING RETURNING id`,
      [randomUUID(), versionId, scope.workspaceId, scope.userId, operation, sha256])
      if (operation === 'withdraw') {
        // Like an ordinary stop, a queued run without a machine binding has
        // no daemon to acknowledge STOP. Finish it in this same transaction.
        const queued=await tx.query<{id:string;userId:string;botId:string|null;issueId:string|null;kind:string}>(`UPDATE agent_runs r
          SET status='stopped',"finishedAt"=clock_timestamp(),"stopRequestedAt"=COALESCE("stopRequestedAt",clock_timestamp()),
            "updatedAt"=clock_timestamp()
          WHERE r.status='queued' AND r.id IN (SELECT "runId" FROM improvement_skill_selections WHERE "versionId"=$1)
            AND NOT EXISTS(SELECT 1 FROM thread_machines m WHERE m."runId"=r.id)
          RETURNING r.id,r."userId",r."botId",r."issueId",r.kind`,[versionId])
        for(const run of queued.rows) {
          await withDatabaseClient(tx,()=>recordCoordinatorEvent(db,runFinishedEvent({...run,status:'stopped',stopReason:'cancelled'})))
          ended.push(run)
        }
        await tx.query(`UPDATE agent_runs SET "stopRequestedAt"=COALESCE("stopRequestedAt",clock_timestamp()),
          "leaseExpiresAt"=LEAST("leaseExpiresAt",clock_timestamp()),"updatedAt"=clock_timestamp()
          WHERE id IN (SELECT "runId" FROM improvement_skill_selections WHERE "versionId"=$1) AND status=ANY($2::text[])`,
        [versionId, [...UNFINISHED_RUN_STATUSES]])
        await tx.query(`UPDATE run_tokens SET "revokedAt"=COALESCE("revokedAt",clock_timestamp()) WHERE "runId"
          IN (SELECT "runId" FROM improvement_skill_selections WHERE "versionId"=$1)`, [versionId])
      }
      if (inserted.rowCount) await withDatabaseClient(tx, () => recordAudit(db, { workspaceId: scope.workspaceId,
        actor: { type: 'user', id: scope.userId, name: scope.userId }, action: operation === 'approve' ? 'skill.reviewed' : 'skill.withdrawn',
        target: { type: 'skill', id: version.artifact.skillId, label: version.skill.name },
        metadata: { versionId, sha256, format: version.artifact.format } }))
      return { artifact: version.artifact, status: operation === 'withdraw' ? 'withdrawn' as const : 'approved' as const }
    }, { guard: guard(scope, true) })
    for(const run of ended)await afterRunEnded(run.userId,run.id)
    return result
  }
}
