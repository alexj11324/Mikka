import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { skillArtifactRefSchema, type SkillArtifactRef } from '@mikka/protocol/skill'
import { bindingSchema } from '../factory/contract'
import { assignedSkillForRun } from './assignments'
import { BASELINE_ARTIFACT, BASELINE_MARKDOWN } from './builtin-skill'
import { digest, ImprovementError } from './contract'
import { SKILL_PATH } from './regression'
import { canonicalSkill, githubRepository, readCommittedSkill, type SkillSourceReader } from './source'
export { canonicalSkill } from './source'

type Authorize = (userId: string, issueId: string, tx: PoolClient) => Promise<boolean>
export interface SkillCandidateMetadata {
  versionId: string; userId: string; issueId: string; agentId: string; repoId: string;
  proposalId: string; factoryTaskId: string; candidateId: string; repository: string;
  commitSha: string; path: string; baselineVersionId: string; createdAt: Date
}
const requestSchema = z.object({ proposalId: z.uuid(), binding: bindingSchema }).strict()

/** Shared with selection/publication, without taking Factory task locks in claim paths. */
export async function lockSkillScope(tx: PoolClient, userId: string, issueId: string, repoId: string) {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`improvement-skill:${JSON.stringify([userId, issueId, repoId])}`])
}

/** Content and scope only. Selection must separately enforce current execution policy. */
export async function resolveSkillVersion(tx: PoolClient, userId: string,
  run: { id?: string; issueId: string; agentId: string; deviceRepoId: string }, versionId: string) {
  if (!z.uuid().safeParse(versionId).success) throw new ImprovementError('sourceMismatch')
  const { rows: [version] } = await tx.query('SELECT artifact,markdown FROM improvement_skill_versions WHERE id=$1', [versionId])
  if (!version) throw new ImprovementError('sourceRequired')
  const parsed = skillArtifactRefSchema.safeParse(version.artifact)
  if (!parsed.success || parsed.data.versionId !== versionId ||
    typeof version.markdown !== 'string' ||
    createHash('sha256').update(version.markdown, 'utf8').digest('hex') !== parsed.data.sha256)
    throw new ImprovementError('sourceMismatch')
  if (parsed.data.registryId === 'mikka-team') {
    const {resolveTeamRunSkill}=await import('./team-skills')
    return resolveTeamRunSkill(tx,userId,run,parsed.data)
  }
  if (parsed.data.skillId !== BASELINE_ARTIFACT.skillId) throw new ImprovementError('sourceMismatch')
  const skill = canonicalSkill(version.markdown)
  let metadata: SkillCandidateMetadata | null = null
  if (versionId === BASELINE_ARTIFACT.versionId) {
    if (version.markdown !== BASELINE_MARKDOWN || digest(parsed.data) !== digest(BASELINE_ARTIFACT))
      throw new ImprovementError('configurationDrift')
  } else {
    const { rows: [candidate] } = await tx.query<SkillCandidateMetadata>(
      'SELECT * FROM improvement_skill_candidates WHERE "versionId"=$1 AND "userId"=$2', [versionId, userId])
    if (!candidate || candidate.issueId !== run.issueId || candidate.agentId !== run.agentId ||
      candidate.repoId !== run.deviceRepoId || candidate.path !== SKILL_PATH ||
      candidate.baselineVersionId !== BASELINE_ARTIFACT.versionId)
      throw new ImprovementError('sourceMismatch')
    metadata = candidate
  }
  return { artifact: parsed.data, markdown: version.markdown as string, skill, metadata }
}

export type CurrentSkillRun = { id: string; issueId: string; agentId: string; deviceRepoId: string }
export type SkillEvaluationAuthorization = (tx: PoolClient, userId: string, run: CurrentSkillRun,
  evaluationId: string, artifact: SkillArtifactRef) => Promise<boolean>

/** Caller already validates the live run, issue authorization, lease and receipt. */
export async function currentSkillEligibility(tx: PoolClient, userId: string, run: CurrentSkillRun,
  artifact: SkillArtifactRef, authorizeEvaluation?: SkillEvaluationAuthorization): Promise<void> {
  if (digest(artifact) === digest(BASELINE_ARTIFACT)) return
  if (artifact.registryId === 'mikka-team') { const {resolveTeamRunSkill}=await import('./team-skills');await resolveTeamRunSkill(tx,userId,run,artifact);return }
  await lockSkillScope(tx, userId, run.issueId, run.deviceRepoId)
  const resolved = await resolveSkillVersion(tx, userId, run, artifact.versionId)
  if (!resolved.metadata || digest(resolved.artifact) !== digest(artifact)) throw new ImprovementError('sourceMismatch')
  const { rows: [withdrawn] } = await tx.query(`SELECT id FROM improvement_skill_lifecycle
    WHERE "versionId"=$1 AND "userId"=$2 AND "issueId"=$3 AND "repoId"=$4 AND operation='withdraw' LIMIT 1`,
    [artifact.versionId, userId, run.issueId, run.deviceRepoId])
  if (withdrawn) throw new ImprovementError('runUnavailable')
  const { rows: [purpose] } = await tx.query(`SELECT * FROM improvement_skill_run_purposes
    WHERE "runId"=$1 AND "userId"=$2 AND "versionId"=$3`, [run.id, userId, artifact.versionId])
  if (!purpose) throw new ImprovementError('sourceRequired')
  if (purpose.purpose === 'evaluation') {
    if (!purpose.evaluationId || !authorizeEvaluation ||
      !await authorizeEvaluation(tx, userId, run, purpose.evaluationId, artifact)) throw new ImprovementError('sourceRequired')
  } else if (purpose.purpose === 'active' && purpose.evaluationId === null) {
    const { rows: [latest] } = await tx.query(`SELECT * FROM improvement_skill_lifecycle
      WHERE "userId"=$1 AND "issueId"=$2 AND "repoId"=$3 ORDER BY "createdAt" DESC,id DESC LIMIT 1`,
      [userId, run.issueId, run.deviceRepoId])
    if (!latest || latest.operation !== 'activate' || latest.versionId !== artifact.versionId)
      throw new ImprovementError('runUnavailable')
  } else throw new ImprovementError('sourceMismatch')
}

export function createSkillRegistry(pool: Pool, authorize: Authorize) {
  async function transaction<T>(work: (tx: PoolClient) => Promise<T>) {
    const tx = await pool.connect()
    try { await tx.query('BEGIN'); const result = await work(tx); await tx.query('COMMIT'); return result }
    catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
  }
  async function context(tx: PoolClient, userId: string, input: z.infer<typeof requestSchema>) {
    const { binding } = input
    // Factory writers already take task, then issue, then run locks.
    const { rows: [task] } = await tx.query('SELECT * FROM factory_tasks WHERE id=$1 AND "userId"=$2 FOR UPDATE', [binding.taskId, userId])
    if (!task || task.issueId !== binding.issueId) throw new ImprovementError('notFound')
    await tx.query('SELECT id FROM issues WHERE id=$1 FOR SHARE', [task.issueId])
    if (!await authorize(userId, task.issueId, tx)) throw new ImprovementError('notFound')
    if (task.attemptId !== binding.attemptId || task.revision !== binding.revision || !task.candidateId ||
      task.candidateId !== binding.candidateId || ['cancelled', 'revoked'].includes(task.status))
      throw new ImprovementError('runUnavailable')
    const { rows: [proposal] } = await tx.query('SELECT * FROM improvement_proposals WHERE id=$1 AND "userId"=$2', [input.proposalId, userId])
    const { rows: [link] } = await tx.query('SELECT * FROM improvement_factory_links WHERE "proposalId"=$1 AND "userId"=$2', [input.proposalId, userId])
    const { rows: [candidate] } = await tx.query('SELECT * FROM factory_candidates WHERE id=$1 AND "taskId"=$2 FOR SHARE', [task.candidateId, task.id])
    const { rows: [attempt] } = await tx.query(`SELECT * FROM factory_attempts WHERE id=$1 AND "taskId"=$2 FOR SHARE`, [link?.attemptId ?? null, task.id])
    if (!proposal || proposal.issueId !== task.issueId || proposal.status !== 'awaiting_model_candidate' ||
      proposal.candidate?.kind !== 'feedback_candidate_request_v1' || proposal.candidate.path !== SKILL_PATH ||
      proposal.candidate.baseline !== BASELINE_MARKDOWN || proposal.candidate.baselineDigest !== BASELINE_ARTIFACT.sha256 ||
      digest(proposal.candidate.baselineArtifact) !== digest(BASELINE_ARTIFACT) ||
      proposal.result?.kind !== 'not_evaluated' || proposal.result?.state !== 'not_evaluated' ||
      proposal.result?.productionEligible !== false || !link || link.issueId !== task.issueId || link.taskId !== task.id ||
      !candidate || !attempt || attempt.stage !== 'execute' || attempt.status !== 'passed' ||
      attempt.candidateId !== candidate.id || attempt.runId !== candidate.runId || link.runId !== candidate.runId)
      throw new ImprovementError('sourceMismatch')
    if (!z.uuid().safeParse(link.request?.deviceRepoId).success) throw new ImprovementError('sourceMismatch')
    await lockSkillScope(tx, userId, task.issueId, link.request.deviceRepoId)
    const { rows: [run] } = await tx.query(`SELECT r.*,coalesce(repo."remoteUrl",repo."repoPath") AS repository
      FROM agent_runs r JOIN agents a ON a.id=r."agentId" AND a."userId"=$2 AND a."deviceId"=r."deviceId"
      JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."userId"=$2 AND repo."deviceId"=r."deviceId"
      JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=$2 AND d.enabled=true
      WHERE r.id=$1 AND r."userId"=$2 FOR SHARE OF r,a,repo,d`, [candidate.runId, userId])
    if (!run || run.issueId !== task.issueId || run.status !== 'succeeded' || run.stopRequestedAt ||
      run.stopReason !== 'submitted' || !run.sessionId || !run.startedAt || !run.finishedAt ||
      attempt.sessionId !== run.sessionId || run.report?.publish?.commit !== candidate.sha ||
      run.report.publish.pushed !== true || run.report.verify?.status !== 'passed' ||
      !/^[a-f0-9]{40}$/.test(run.report.sourceCommit ?? '') ||
      link.request?.agentId !== run.agentId || link.request?.deviceRepoId !== run.deviceRepoId ||
      githubRepository(candidate.repository) !== githubRepository(run.repository))
      throw new ImprovementError('sourceMismatch')
    const { rows: sources } = await tx.query(`SELECT r.*,s.snapshot,s."scorerDigest",s.outcome,s.bucket,
      src."scoreId",src."runId" AS "sourceRunId",src.bucket AS "sourceBucket",
      coalesce(repo."remoteUrl",repo."repoPath") AS repository
      FROM improvement_proposal_sources src JOIN improvement_scores s ON s.id=src."scoreId" AND s."userId"=$2
      JOIN agent_runs r ON r.id=src."runId" AND r.id=s."runId" AND r."userId"=$2
      JOIN agents a ON a.id=r."agentId" AND a."userId"=$2 AND a."deviceId"=r."deviceId"
      JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."userId"=$2 AND repo."deviceId"=r."deviceId"
      JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=$2 AND d.enabled=true
      WHERE src."proposalId"=$1 AND src."userId"=$2 ORDER BY r.id FOR SHARE OF r,a,repo,d`, [proposal.id, userId])
    const { rows: [count] } = await tx.query('SELECT count(*)::int AS total FROM improvement_proposal_sources WHERE "proposalId"=$1', [proposal.id])
    if (!sources.length || sources.length !== count.total) throw new ImprovementError('sourceRequired')
    if (digest(proposal.candidate.sourceIds) !== digest(sources.map(source => source.scoreId).sort()))
      throw new ImprovementError('sourceMismatch')
    for (const source of sources) {
      if (source.issueId !== task.issueId || source.agentId !== run.agentId || source.deviceRepoId !== run.deviceRepoId ||
        source.stopRequestedAt || !['succeeded', 'failed'].includes(source.status) || !source.finishedAt || !source.sessionId ||
        source.outcome !== 'failure' || source.scorerDigest !== proposal.scorerDigest || source.bucket !== proposal.bucket ||
        source.sourceBucket !== proposal.bucket || source.snapshot?.repository !== source.repository ||
        githubRepository(source.repository) !== githubRepository(candidate.repository) ||
        source.snapshot?.runId !== source.id || source.snapshot?.issueId !== source.issueId ||
        source.snapshot?.agentId !== source.agentId || source.snapshot?.deviceRepoId !== source.deviceRepoId ||
        source.snapshot?.sessionId !== source.sessionId || source.snapshot?.reportDigest !== digest(source.report))
        throw new ImprovementError('sourceMismatch')
      const assigned = await assignedSkillForRun(tx, userId, source)
      if (assigned.skillUsage !== 'assigned' || digest(assigned.skillArtifact) !== digest(BASELINE_ARTIFACT) ||
        digest(source.snapshot.skillArtifact) !== digest(assigned.skillArtifact) ||
        source.snapshot.skillReceipt?.id !== assigned.skillReceipt.id) throw new ImprovementError('sourceMismatch')
    }
    const metadata = { versionId: candidate.id, userId, issueId: task.issueId, agentId: run.agentId,
      repoId: run.deviceRepoId, proposalId: proposal.id, factoryTaskId: task.id, candidateId: candidate.id,
      repository: candidate.repository, commitSha: candidate.sha, path: SKILL_PATH,
      baselineVersionId: BASELINE_ARTIFACT.versionId }
    return { metadata, source: { repository: candidate.repository as string, sha: candidate.sha as string,
      baseSha: run.report.sourceCommit as string, path: SKILL_PATH },
      fingerprint: digest({ metadata, task, candidate, attempt, run, sources }) }
  }
  return {
    /** Recheck live source provenance for activation while retaining immutable registered bytes. */
    async readRegisteredCandidate(tx: PoolClient, userId: string, taskId: string, candidateId: string) {
      if (!z.uuid().safeParse(taskId).success || !z.uuid().safeParse(candidateId).success) throw new ImprovementError('notFound')
      const { rows: [metadata] } = await tx.query<SkillCandidateMetadata>(`SELECT * FROM improvement_skill_candidates
        WHERE "factoryTaskId"=$1 AND "candidateId"=$2 AND "userId"=$3`, [taskId, candidateId, userId])
      const { rows: [task] } = await tx.query('SELECT * FROM factory_tasks WHERE id=$1 AND "userId"=$2 FOR UPDATE', [taskId, userId])
      if (!metadata || !task) throw new ImprovementError('notFound')
      const live = await context(tx, userId, { proposalId: metadata.proposalId, binding: {
        taskId, issueId: task.issueId, attemptId: task.attemptId, revision: task.revision, candidateId,
      } })
      const { createdAt: _createdAt, ...stored } = metadata
      if (digest(stored) !== digest(live.metadata)) throw new ImprovementError('sourceMismatch')
      const resolved = await resolveSkillVersion(tx, userId, { issueId: metadata.issueId, agentId: metadata.agentId,
        deviceRepoId: metadata.repoId }, metadata.versionId)
      if (!resolved.metadata) throw new ImprovementError('sourceMismatch')
      return { ...resolved, metadata: resolved.metadata }
    },
    async registerCandidate(userId: string, input: z.infer<typeof requestSchema>, sourceReader: SkillSourceReader = readCommittedSkill) {
      const parsed = requestSchema.safeParse(input)
      if (!parsed.success) throw new ImprovementError('invalid')
      const before = await transaction(tx => context(tx, userId, parsed.data))
      // Source I/O never holds database locks. The second transaction rechecks every live binding.
      const markdown = await sourceReader(before.source)
      canonicalSkill(markdown)
      const artifact: SkillArtifactRef = { ...BASELINE_ARTIFACT, versionId: before.metadata.versionId,
        sha256: createHash('sha256').update(markdown, 'utf8').digest('hex') }
      if (artifact.versionId === BASELINE_ARTIFACT.versionId) throw new ImprovementError('conflict')
      return transaction(async tx => {
        const after = await context(tx, userId, parsed.data)
        if (after.fingerprint !== before.fingerprint) throw new ImprovementError('conflict')
        await resolveSkillVersion(tx, userId, { issueId: after.metadata.issueId, agentId: after.metadata.agentId,
          deviceRepoId: after.metadata.repoId }, BASELINE_ARTIFACT.versionId)
        await tx.query('INSERT INTO improvement_skill_versions(id,artifact,markdown) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [artifact.versionId, JSON.stringify(artifact), markdown])
        const m = after.metadata
        await tx.query(`INSERT INTO improvement_skill_candidates("versionId","userId","issueId","agentId","repoId",
          "proposalId","factoryTaskId","candidateId",repository,"commitSha",path,"baselineVersionId")
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`, Object.values(m))
        const stored = await resolveSkillVersion(tx, userId, { issueId: m.issueId, agentId: m.agentId, deviceRepoId: m.repoId }, artifact.versionId)
        const { createdAt: _createdAt, ...persisted } = stored.metadata!
        if (digest(persisted) !== digest(m) || digest(stored.artifact) !== digest(artifact) || stored.markdown !== markdown)
          throw new ImprovementError('conflict')
        return { artifact: stored.artifact, ...stored.metadata! }
      })
    },
  }
}
