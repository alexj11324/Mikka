import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { RUN_LEASE_MS } from '@mikka/protocol/device'
import { skillAssignmentReceiptSchema } from '@mikka/protocol/skill'
import { BASELINE_ARTIFACT, BASELINE_MARKDOWN } from './builtin-skill'
import { digest, ImprovementError } from './contract'
import { currentSkillEligibility, lockSkillScope, resolveSkillVersion, type SkillEvaluationAuthorization } from './registry'

type Authorize = (userId: string, issueId: string, tx: PoolClient) => Promise<boolean>
type EvaluationPurpose = { purpose: 'evaluation'; evaluationId: string }
type ActivePurpose = { purpose: 'active'; evaluationId: null }
export function createSkillAssignments(pool: Pool, authorize: Authorize, authorizeEvaluation?: SkillEvaluationAuthorization) {
  async function transaction<T>(work: (tx: PoolClient) => Promise<T>) {
    const tx = await pool.connect()
    try { await tx.query('BEGIN'); const result = await work(tx); await tx.query('COMMIT'); return result }
    catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
  }
  async function owned(tx: PoolClient, userId: string, runId: string, lockRun=false) {
    if (!z.uuid().safeParse(runId).success) throw new ImprovementError('notFound')
    const { rows: [source] } = await tx.query('SELECT "issueId","deviceRepoId" FROM agent_runs WHERE id=$1 AND "userId"=$2', [runId, userId])
    if (!source?.issueId || !source.deviceRepoId) throw new ImprovementError('notFound')
    await tx.query('SELECT id FROM issues WHERE id=$1 FOR SHARE', [source.issueId])
    if (!await authorize(userId, source.issueId, tx)) throw new ImprovementError('notFound')
    await lockSkillScope(tx, userId, source.issueId, source.deviceRepoId)
    const { rows: [run] } = await tx.query(`SELECT r.* FROM agent_runs r
      JOIN agents a ON a.id=r."agentId" AND a."userId"=$2 AND a."deviceId"=r."deviceId"
      JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."userId"=$2 AND repo."deviceId"=r."deviceId"
      JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=$2 AND d.enabled=true
      WHERE r.id=$1 AND r."userId"=$2 ${lockRun?'FOR UPDATE OF r FOR SHARE OF a,repo,d':'FOR SHARE OF r,a,repo,d'}`, [runId, userId])
    if (!run?.issueId || run.issueId !== source.issueId || run.deviceRepoId !== source.deviceRepoId) throw new ImprovementError('notFound')
    if (run.stopRequestedAt || run.status === 'cancelled') throw new ImprovementError('runUnavailable')
    return run
  }
  async function baseline(tx: PoolClient) {
    await tx.query('INSERT INTO improvement_skill_versions(id,artifact,markdown) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
      [BASELINE_ARTIFACT.versionId, JSON.stringify(BASELINE_ARTIFACT), BASELINE_MARKDOWN])
    const { rows: [row] } = await tx.query('SELECT * FROM improvement_skill_versions WHERE id=$1', [BASELINE_ARTIFACT.versionId])
    if (!row || digest(row.artifact) !== digest(BASELINE_ARTIFACT) || row.markdown !== BASELINE_MARKDOWN)
      throw new ImprovementError('configurationDrift')
  }
  async function selected(tx: PoolClient, userId: string, run: Awaited<ReturnType<typeof owned>>, selection: Record<string, string>) {
    if (selection.userId !== userId || selection.issueId !== run.issueId || selection.agentId !== run.agentId ||
      selection.repoId !== run.deviceRepoId || selection.deviceId !== run.deviceId || selection.runId !== run.id)
      throw new ImprovementError('sourceMismatch')
    if (selection.versionId === BASELINE_ARTIFACT.versionId) await baseline(tx)
    const version = await resolveSkillVersion(tx, userId, run, selection.versionId)
    await currentSkillEligibility(tx, userId, run, version.artifact, authorizeEvaluation)
    return version
  }
  async function select(tx: PoolClient, userId: string, run: Awaited<ReturnType<typeof owned>>, versionId: string,
    purpose?: EvaluationPurpose | ActivePurpose) {
    // CI resumes the original session and cannot acquire a new skill grant.
    // Skill-bearing origin runs are excluded until their provenance is carried.
    if (run.ciContinuation) throw new ImprovementError('runUnavailable')
    const { rows:[prior] } = await tx.query('SELECT * FROM improvement_skill_selections WHERE "runId"=$1',[run.id])
    if (!prior && (run.status !== 'queued' || run.startedAt)) throw new ImprovementError('runUnavailable')
    if (versionId === BASELINE_ARTIFACT.versionId) await baseline(tx)
    const version = await resolveSkillVersion(tx, userId, run, versionId)
    if (purpose?.purpose === 'evaluation' && (!z.uuid().safeParse(purpose.evaluationId).success || !authorizeEvaluation ||
      !await authorizeEvaluation(tx, userId, run, purpose.evaluationId, version.artifact))) throw new ImprovementError('sourceRequired')
    if (purpose) {
      await tx.query(`INSERT INTO improvement_skill_run_purposes("runId","userId","versionId",purpose,"evaluationId")
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [run.id, userId, versionId, purpose.purpose, purpose.evaluationId])
      const { rows:[stored] } = await tx.query('SELECT * FROM improvement_skill_run_purposes WHERE "runId"=$1', [run.id])
      if (!stored || stored.userId !== userId || stored.versionId !== versionId || stored.purpose !== purpose.purpose ||
        stored.evaluationId !== purpose.evaluationId) throw new ImprovementError('conflict')
    }
    await currentSkillEligibility(tx, userId, run, version.artifact, authorizeEvaluation)
    await tx.query(`INSERT INTO improvement_skill_selections("runId","userId","issueId","agentId","repoId","deviceId","versionId")
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [run.id, userId, run.issueId, run.agentId, run.deviceRepoId, run.deviceId, versionId])
    const { rows: [selection] } = await tx.query('SELECT * FROM improvement_skill_selections WHERE "runId"=$1', [run.id])
    if (!selection || selection.versionId !== versionId) throw new ImprovementError('conflict')
    await selected(tx, userId, run, selection)
    return { runId: run.id as string, artifact: version.artifact, status: 'selection_persisted' as const }
  }
  async function selectBaseline(userId: string, runId: string, existingTransaction?: PoolClient) {
    const work = async (tx: PoolClient) => select(tx, userId, await owned(tx, userId, runId), BASELINE_ARTIFACT.versionId)
    return existingTransaction ? work(existingTransaction) : transaction(work)
  }
  // Internal only: the benchmark service owns the transaction and frozen run binding.
  async function selectVersion(userId: string, runId: string, versionId: string, purpose: EvaluationPurpose, tx: PoolClient) {
    if (purpose.purpose !== 'evaluation') throw new ImprovementError('invalid')
    return select(tx, userId, await owned(tx, userId, runId), versionId, purpose)
  }
  async function selectActive(userId: string, runId: string, existingTransaction?: PoolClient) {
    const work = async (tx: PoolClient) => {
      const run = await owned(tx, userId, runId)
      const { rows:[latest] } = await tx.query(`SELECT * FROM improvement_skill_lifecycle
        WHERE "userId"=$1 AND "issueId"=$2 AND "repoId"=$3 ORDER BY "createdAt" DESC,id DESC LIMIT 1`,
        [userId, run.issueId, run.deviceRepoId])
      if (!latest || latest.operation !== 'activate') throw new ImprovementError('sourceRequired')
      return select(tx, userId, run, latest.versionId, { purpose: 'active', evaluationId: null })
    }
    return existingTransaction ? work(existingTransaction) : transaction(work)
  }
  // Match dispatch -> selection and scope -> run ordering before Factory locks the origin.
  async function lockQuestion(userId: string, issueId: string, runId: string, tx: PoolClient) {
    const {rows:[source]}=await tx.query(`SELECT repo."repoPath" FROM agent_runs r
      JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."userId"=r."userId"
      WHERE r.id=$1 AND r."userId"=$2 AND r."issueId"=$3 FOR SHARE OF repo`,[runId,userId,issueId])
    if (!source) throw new ImprovementError('sourceMismatch')
    // Admission and continuations use the same repository -> issue order.
    // The host acquires CLI policy before any source run/worker lock.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [JSON.stringify(['repository-approval', userId, source.repoPath])])
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
      [JSON.stringify(['dispatch-issue', userId, issueId])])
    const run = await owned(tx, userId, runId)
    if (run.issueId !== issueId) throw new ImprovementError('sourceMismatch')
  }
  // The question answer owns this transaction, so selection commits before the run can be claimed.
  async function continueQuestion(userId: string, runId: string, tx: PoolClient) {
    const run = await owned(tx, userId, runId)
    if (run.status !== 'queued' || run.startedAt) throw new ImprovementError('runUnavailable')
    let child = run
    let taskId: string | undefined
    const visited = new Set<string>([runId])
    for (let depth = 0; depth < 10; depth++) {
      const link = child.questionContinuation
      if (!link || link.requireSessionResume !== true || !z.uuid().safeParse(link.originRunId).success ||
        visited.has(link.originRunId)) throw new ImprovementError('sourceMismatch')
      const { rows: [question] } = await tx.query(`SELECT "taskId" FROM factory_questions
        WHERE id=$1 AND "userId"=$2 AND "issueId"=$3 AND "originRunId"=$4
        AND "originSessionId"=$5 AND "continuationRunId"=$6`,
        [link.questionId, userId, run.issueId, link.originRunId, link.originSessionId, child.id])
      if (!question || (taskId && taskId !== question.taskId)) throw new ImprovementError('sourceMismatch')
      taskId = question.taskId
      const origin = await owned(tx, userId, link.originRunId)
      if (origin.status !== 'stopped' || !origin.sessionId || origin.sessionId !== link.originSessionId ||
        (child.sessionId && child.sessionId !== origin.sessionId) || origin.issueId !== run.issueId ||
        origin.agentId !== run.agentId || origin.deviceRepoId !== run.deviceRepoId || origin.deviceId !== run.deviceId)
        throw new ImprovementError('sourceMismatch')
      const { rows: [selection] } = await tx.query('SELECT * FROM improvement_skill_selections WHERE "runId"=$1', [origin.id])
      if (selection) {
        await selected(tx, userId, origin, selection)
        const { rows: [purpose] } = await tx.query('SELECT * FROM improvement_skill_run_purposes WHERE "runId"=$1', [origin.id])
        // Benchmark arms bind a fixed run; an answer cannot authorize a replacement arm.
        if (purpose && (purpose.purpose !== 'active' || purpose.evaluationId !== null || purpose.userId !== userId ||
          purpose.versionId !== selection.versionId)) throw new ImprovementError('sourceRequired')
        await select(tx, userId, run, selection.versionId, purpose ? { purpose: 'active', evaluationId: null } : undefined)
        return
      }
      if (!origin.questionContinuation) return
      visited.add(origin.id)
      child = origin
    }
    throw new ImprovementError('sourceRequired')
  }
  async function preflight(userId: string, runId: string, supportsArtifacts: boolean) {
    const { rows: [selection] } = await pool.query('SELECT * FROM improvement_skill_selections WHERE "runId"=$1', [runId])
    if (!selection) {
      const { rows:[ancestor] }=await pool.query(`WITH RECURSIVE lineage AS (
        SELECT id,"retryOf","questionContinuation","userId",0 AS depth FROM agent_runs WHERE id=$1 AND "userId"=$2
        UNION ALL SELECT r.id,r."retryOf",r."questionContinuation",r."userId",l.depth+1 FROM agent_runs r JOIN lineage l
          ON r.id::text IN (l."retryOf"::text,l."questionContinuation"->>'originRunId') WHERE r."userId"=$2 AND l.depth<10
      ) SELECT 1 FROM lineage l LEFT JOIN improvement_skill_selections s ON s."runId"=l.id AND s."userId"=$2
        WHERE s."runId" IS NOT NULL OR l.depth=10 LIMIT 1`,[runId,userId])
      if (ancestor) throw new ImprovementError('sourceRequired')
      return
    }
    if (selection.userId !== userId) throw new ImprovementError('notFound')
    if (!supportsArtifacts) throw new ImprovementError('workerCapabilityRequired')
    await transaction(async tx => { await selected(tx, userId, await owned(tx, userId, runId), selection) })
  }
  // Called after the actual claim CAS, before returning that assignment. A
  // receipt proves the server prepared assignment bytes, never delivery/use.
  async function recordClaim(userId: string, deviceId: string, runId: string, leaseExpiresAt: string, supportsArtifacts: boolean) {
    await preflight(userId,runId,supportsArtifacts)
    return transaction(async tx => {
      const { rows: [selection] } = await tx.query('SELECT * FROM improvement_skill_selections WHERE "runId"=$1', [runId])
      if (!selection) return {}
      if (!supportsArtifacts) throw new ImprovementError('workerCapabilityRequired')
      const run = await owned(tx, userId, runId)
      if (run.status !== 'preparing' || run.deviceId !== deviceId || !run.startedAt || !run.leaseExpiresAt ||
        run.leaseExpiresAt.getTime() !== new Date(leaseExpiresAt).getTime() || run.leaseExpiresAt.getTime() <= Date.now())
        throw new ImprovementError('runUnavailable')
      const version = await selected(tx, userId, run, selection)
      const receipt = skillAssignmentReceiptSchema.parse({ id: randomUUID(), runId, issueId: run.issueId,
        agentId: run.agentId, repoId: run.deviceRepoId, deviceId, leaseExpiresAt,
        assignedAt: new Date().toISOString(), artifact: version.artifact })
      await tx.query('INSERT INTO improvement_skill_receipts(id,"runId","userId",receipt) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [receipt.id, runId, userId, JSON.stringify(receipt)])
      const { rows: [stored] } = await tx.query('SELECT * FROM improvement_skill_receipts WHERE "runId"=$1', [runId])
      const parsed = skillAssignmentReceiptSchema.parse(stored.receipt)
      if (stored.userId !== userId || parsed.runId !== runId || parsed.issueId !== run.issueId || parsed.agentId !== run.agentId ||
        parsed.repoId !== run.deviceRepoId || parsed.deviceId !== deviceId || parsed.leaseExpiresAt !== leaseExpiresAt ||
        digest(parsed.artifact) !== digest(version.artifact)) throw new ImprovementError('conflict')
      return { skills: [version.skill], skillReceipt: parsed }
    })
  }
  async function revalidate(userId:string,runId:string,receiptId:string,supportsArtifacts:boolean) {
    if (!supportsArtifacts) throw new ImprovementError('workerCapabilityRequired')
    return transaction(async tx=>{
      const run=await owned(tx,userId,runId)
      if (!['preparing','running','waiting_input','finishing'].includes(run.status)||!run.leaseExpiresAt||run.leaseExpiresAt.getTime()<=Date.now())
        throw new ImprovementError('runUnavailable')
      const source=await assignedSkillForRun(tx,userId,run)
      if (source.skillUsage!=='assigned'||source.skillReceipt.id!==receiptId) throw new ImprovementError('sourceMismatch')
      await currentSkillEligibility(tx,userId,run,source.skillArtifact,authorizeEvaluation)
      return {skillReceipt:source.skillReceipt,leaseExpiresAt:run.leaseExpiresAt.toISOString()}
    })
  }
  async function renewHeartbeat(userId:string,deviceId:string,runIds:string[],supportsArtifacts:boolean) {
    // Protocol IDs may be non-UUIDs; the legacy lease boundary revokes those after partitioning.
    const validRunIds=runIds.filter(id=>z.uuid().safeParse(id).success)
    const {rows}=await pool.query(`SELECT s."runId",r.id FROM improvement_skill_selections s
      LEFT JOIN improvement_skill_receipts r ON r."runId"=s."runId" AND r."userId"=s."userId"
      WHERE s."userId"=$1 AND s."runId"=ANY($2::uuid[])`,[userId,validRunIds])
    const revoked:string[]=[],leases:Record<string,string>={}
    for(const row of rows) {
      try {
        if(!supportsArtifacts||!row.id)throw new ImprovementError('workerCapabilityRequired')
        leases[row.runId]=await transaction(async tx=>{
          const run=await owned(tx,userId,row.runId,true)
          if(run.deviceId!==deviceId||!['preparing','running','waiting_input','finishing'].includes(run.status)||!run.leaseExpiresAt||run.leaseExpiresAt.getTime()<=Date.now())
            throw new ImprovementError('runUnavailable')
          const source=await assignedSkillForRun(tx,userId,run)
          if(source.skillUsage!=='assigned'||source.skillReceipt.id!==row.id)throw new ImprovementError('sourceMismatch')
          await currentSkillEligibility(tx,userId,run,source.skillArtifact,authorizeEvaluation)
          const expiry=new Date(Date.now()+RUN_LEASE_MS).toISOString()
          const changed=await tx.query(`UPDATE agent_runs SET "leaseExpiresAt"=$4,"updatedAt"=now() WHERE id=$1 AND "userId"=$2 AND "deviceId"=$3
            AND "stopRequestedAt" IS NULL AND "leaseExpiresAt"=$5 AND "leaseExpiresAt">now() RETURNING id`,[run.id,userId,deviceId,expiry,run.leaseExpiresAt])
          if(!changed.rowCount)throw new ImprovementError('runUnavailable')
          return expiry
        })
      }
      catch(error) {if (!(error instanceof ImprovementError)) throw error;revoked.push(row.runId)}
    }
    const protectedIds=new Set(rows.map(row=>row.runId))
    return {legacy:runIds.filter(id=>!protectedIds.has(id)),leases,revoked}
  }
  return { selectBaseline, selectVersion, selectActive, lockQuestion, continueQuestion, preflight, recordClaim, revalidate, renewHeartbeat }
}

/** Historical provenance stays readable after source withdrawal or task revocation. */
export async function assignedSkillForRun(tx: PoolClient, userId: string, run: {
  id: string; issueId: string; agentId: string; deviceRepoId: string; deviceId: string; startedAt?: Date | null
}) {
  const { rows: [row] } = await tx.query(`SELECT s.*,v.artifact,v.markdown FROM improvement_skill_receipts s
    JOIN improvement_skill_versions v ON v.id=(s.receipt->'artifact'->>'versionId')::uuid
    WHERE s."runId"=$1 AND s."userId"=$2`, [run.id, userId])
  if (!row) return { skillUsage: 'unrecorded' as const }
  const receipt = skillAssignmentReceiptSchema.safeParse(row.receipt)
  if (!receipt.success || receipt.data.issueId !== run.issueId || receipt.data.agentId !== run.agentId ||
    receipt.data.repoId !== run.deviceRepoId || receipt.data.deviceId !== run.deviceId || !run.startedAt ||
    new Date(receipt.data.assignedAt).getTime() < run.startedAt.getTime() ||
    digest(row.artifact) !== digest(receipt.data.artifact) ||
    createHash('sha256').update(row.markdown,'utf8').digest('hex') !== receipt.data.artifact.sha256)
    throw new ImprovementError('sourceMismatch')
  const version = await resolveSkillVersion(tx, userId, run, receipt.data.artifact.versionId)
  if (digest(version.artifact) !== digest(receipt.data.artifact)) throw new ImprovementError('sourceMismatch')
  return { skillUsage: 'assigned' as const, skillReceipt: receipt.data, skillArtifact: receipt.data.artifact,
    usageClaim: 'server_prepared_assignment_not_execution' as const }
}
