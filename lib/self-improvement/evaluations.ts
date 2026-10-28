import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import { runExecution } from '@mikka/protocol/run'
import type { SkillArtifactRef } from '@mikka/protocol/skill'
import type { QueueFactoryRun } from '../factory/dispatch'
import { assignedSkillForRun } from './assignments'
import { compareRegisteredEvaluation, currentModelEvaluation, type ComparisonState, type EvaluationComparisonSnapshot } from './evaluation-comparison'
import type { RegisteredSkillEvaluator } from './registered-evaluation'
import { BASELINE_ARTIFACT } from './builtin-skill'
import { digest, ImprovementError } from './contract'
import type { FailureQualityProvider, ReportQualitySignals } from './regression'
import { resolveSkillVersion, type CurrentSkillRun } from './registry'
import { REPORT_BENCHMARK, buildTask, freezeBenchmarkInstance, evaluateTask, type ReportBenchmarkRun } from './report-benchmark'

const settingsSchema = z.object({ harness: z.string().trim().min(1), model: z.string().trim().min(1),
  policyDigest: z.string().regex(/^[a-f0-9]{64}$/), fixtureDigest: z.string().regex(/^[a-f0-9]{64}$/),
  verifyCommand: z.literal(REPORT_BENCHMARK.verifyCommand) }).strict()
export type EvaluationSettings = z.infer<typeof settingsSchema>
export type BenchmarkAssignment = EvaluationSettings & { sourceCommit:string; benchmarkDigest:string; caseId:string }
export function assertBenchmarkExecution(execution:unknown, expected:BenchmarkAssignment):void {
  const {model,...settings}=expected
  if (digest(execution)!==digest({...settings,requestedModel:model,observedModel:model})) throw new ImprovementError('sourceMismatch')
}
type Authorize = (userId: string, issueId: string, tx: PoolClient) => Promise<boolean>
export type BenchmarkSourceRun = CurrentSkillRun & { userId: string; deviceId: string; report: { sourceCommit?: string }; harness: string }
export type EvaluationDependencies = {
  authorize: Authorize
  assess?: RegisteredSkillEvaluator
  queue: QueueFactoryRun
  settings: (tx: PoolClient, userId: string, source: BenchmarkSourceRun) => Promise<EvaluationSettings>
  selectVersion: (userId: string, runId: string, versionId: string,
    purpose: { purpose: 'evaluation'; evaluationId: string }, tx: PoolClient) => Promise<unknown>
  selectBaseline: (userId: string, runId: string, tx: PoolClient) => Promise<unknown>
}
type Instance = { id: string; userId: string; issueId: string; agentId: string; repoId: string; sourceRunId: string;
  sourceCommit: string; definitionDigest: string; instanceDigest: string; seed: string; settings: EvaluationSettings; createdAt: Date }
type Evaluation = { id: string; instanceId: string; userId: string; proposalId: string; candidateVersionId: string;
  scope: { issueId: string; agentId: string; repoId: string; sourceCommit: string; factoryTaskId: string; candidateId: string }; createdAt: Date }

function frozen(row: Instance) {
  const instance = freezeBenchmarkInstance(row.seed)
  if (row.definitionDigest !== REPORT_BENCHMARK.digest || row.instanceDigest !== instance.digest)
    throw new ImprovementError('configurationDrift')
  settingsSchema.parse(row.settings)
  return instance
}
function publicInstance(row: Instance) {
  return { id: row.id, issueId: row.issueId, agentId: row.agentId, repoId: row.repoId,
    sourceCommit: row.sourceCommit, definitionDigest: row.definitionDigest, instanceDigest: row.instanceDigest, createdAt: row.createdAt }
}

/** Only persisted summary text is scored; the mount is a host-written immutable ledger. */
export function benchmarkEvidence(row: {
  runId: string; caseId: string; versionId: string; status: string; report: { summary?: unknown; sourceCommit?: unknown; verify?: {status?:unknown;command?:unknown;exitCode?:unknown;timedOut?:unknown;signal?:unknown} } | null;
  sessionId: string; stopRequestedAt: Date | null; finishedAt: Date | null; deviceId: string;
  mount: { receiptId: string; sessionId: string; versionId: string; sha256: string; deviceId: string; execution?: unknown } | null
}, expected: { sourceCommit: string; instanceDigest: string; settings: EvaluationSettings; artifact: SkillArtifactRef; receiptId: string }): ReportBenchmarkRun {
  const execution = row.mount?.execution as Record<string, unknown> | undefined
  if (row.status !== 'succeeded' || row.stopRequestedAt || !row.finishedAt || !row.sessionId ||
    typeof row.report?.summary !== 'string' || row.report.sourceCommit !== expected.sourceCommit ||
    row.report.verify?.status!=='passed' || row.report.verify.command!==expected.settings.verifyCommand ||
    row.report.verify.exitCode!==0 || row.report.verify.timedOut===true || row.report.verify.signal!=null ||
    row.mount?.sessionId !== row.sessionId || row.mount.deviceId !== row.deviceId ||
    row.mount.receiptId !== expected.receiptId || row.mount.versionId !== expected.artifact.versionId ||
    row.versionId !== expected.artifact.versionId || row.mount.sha256 !== expected.artifact.sha256 ||
    !execution || digest(execution) !== digest({ harness:expected.settings.harness, requestedModel:expected.settings.model,
      observedModel:expected.settings.model, policyDigest:expected.settings.policyDigest, fixtureDigest:expected.settings.fixtureDigest,
      verifyCommand:expected.settings.verifyCommand, sourceCommit: expected.sourceCommit,
      benchmarkDigest: expected.instanceDigest, caseId: row.caseId })) throw new ImprovementError('sourceMismatch')
  return { caseId: row.caseId, benchmarkVersion: REPORT_BENCHMARK.version, benchmarkDigest: expected.instanceDigest,
    status: 'completed', actualOutput: row.report.summary, ...expected.settings,
    provenance: { runId: row.runId, sessionId: row.sessionId, mountReceiptId: row.mount.receiptId,
      artifactDigest: row.mount.sha256, sourceCommit: expected.sourceCommit } }
}

export function createSkillEvaluations(pool: Pool, dependencies: EvaluationDependencies) {
  async function transaction<T>(work: (tx: PoolClient) => Promise<T>, existing?: PoolClient) {
    if (existing) return work(existing)
    const tx = await pool.connect()
    try { await tx.query('BEGIN'); const result = await work(tx); await tx.query('COMMIT'); return result }
    catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
  }
  async function owned(tx: PoolClient, userId: string, runId: string) {
    const { rows: [source] } = await tx.query('SELECT "issueId" FROM agent_runs WHERE id=$1 AND "userId"=$2', [runId, userId])
    if (!source?.issueId) throw new ImprovementError('notFound')
    await tx.query('SELECT id FROM issues WHERE id=$1 FOR SHARE', [source.issueId])
    if (!await dependencies.authorize(userId, source.issueId, tx)) throw new ImprovementError('notFound')
    const { rows: [run] } = await tx.query(`SELECT r.*,a.harness FROM agent_runs r
      JOIN agents a ON a.id=r."agentId" AND a."userId"=$2 AND a."deviceId"=r."deviceId"
      JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."userId"=$2 AND repo."deviceId"=r."deviceId"
      JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=$2 AND d.enabled=true
      WHERE r.id=$1 AND r."userId"=$2 FOR SHARE OF r,a,repo,d`, [runId, userId])
    if (!run || run.issueId !== source.issueId || run.stopRequestedAt || run.status === 'cancelled') throw new ImprovementError('runUnavailable')
    return run
  }
  async function instanceFor(tx: PoolClient, userId: string, id: string) {
    const { rows: [row] } = await tx.query<Instance>('SELECT * FROM improvement_benchmark_instances WHERE id=$1 AND "userId"=$2', [id, userId])
    if (!row) throw new ImprovementError('notFound')
    const source = await owned(tx, userId, row.sourceRunId)
    if (!['succeeded','failed'].includes(source.status) || !source.finishedAt || !source.sessionId ||
      source.issueId !== row.issueId || source.agentId !== row.agentId || source.deviceRepoId !== row.repoId ||
      source.report?.sourceCommit !== row.sourceCommit || source.harness !== row.settings.harness)
      throw new ImprovementError('sourceMismatch')
    const assigned = await assignedSkillForRun(tx, userId, source)
    if (assigned.skillUsage !== 'assigned' || digest(assigned.skillArtifact) !== digest(BASELINE_ARTIFACT))
      throw new ImprovementError('sourceMismatch')
    frozen(row)
    return row
  }
  async function lockEvaluationTask(tx:PoolClient,userId:string,evaluationId:string) {
    await tx.query(`SELECT t.id FROM improvement_skill_evaluations e JOIN factory_tasks t ON t.id=(e.scope->>'factoryTaskId')::uuid
      WHERE e.id=$1 AND e."userId"=$2 AND t."userId"=$2 FOR SHARE OF t`,[evaluationId,userId])
  }
  // Claim/lease/mount callbacks hold execution locks already; never take Factory task locks here.
  async function evaluationFor(tx: PoolClient, userId: string, evaluationId: string) {
    const { rows: [evaluation] } = await tx.query<Evaluation>('SELECT * FROM improvement_skill_evaluations WHERE id=$1 AND "userId"=$2', [evaluationId, userId])
    if (!evaluation) throw new ImprovementError('notFound')
    const instance = await instanceFor(tx, userId, evaluation.instanceId)
    const resolved = await resolveSkillVersion(tx, userId, { issueId: instance.issueId, agentId: instance.agentId, deviceRepoId: instance.repoId }, evaluation.candidateVersionId)
    const m = resolved.metadata
    if (!m || m.proposalId !== evaluation.proposalId || digest(evaluation.scope) !== digest({ issueId: instance.issueId,
      agentId: instance.agentId, repoId: instance.repoId, sourceCommit: instance.sourceCommit, factoryTaskId: m.factoryTaskId, candidateId: m.candidateId }))
      throw new ImprovementError('sourceMismatch')
    const { rows: [task] } = await tx.query('SELECT * FROM factory_tasks WHERE id=$1 AND "userId"=$2', [m.factoryTaskId, userId])
    const { rows: [candidate] } = await tx.query('SELECT * FROM factory_candidates WHERE id=$1 AND "taskId"=$2', [m.candidateId,m.factoryTaskId])
    const { rows: [withdrawn] } = await tx.query(`SELECT 1 FROM improvement_skill_lifecycle WHERE "versionId"=$1 AND operation='withdraw'`, [m.versionId])
    if (!task || task.issueId !== instance.issueId || task.candidateId !== m.candidateId || ['cancelled','revoked'].includes(task.status) ||
      !candidate || candidate.sha !== m.commitSha || candidate.repository !== m.repository || withdrawn)
      throw new ImprovementError('runUnavailable')
    return { evaluation, instance }
  }
  async function freezeBenchmark(userId: string, sourceRunId: string, existing?: PoolClient) {
    if (!z.uuid().safeParse(sourceRunId).success) throw new ImprovementError('invalid')
    return transaction(async tx => {
      const source = await owned(tx,userId,sourceRunId)
      if (!['succeeded','failed'].includes(source.status) || !source.finishedAt || !source.sessionId ||
        !/^[a-f0-9]{40}$/.test(source.report?.sourceCommit ?? '')) throw new ImprovementError('sourceRequired')
      const assigned = await assignedSkillForRun(tx,userId,source)
      if (assigned.skillUsage !== 'assigned' || digest(assigned.skillArtifact) !== digest(BASELINE_ARTIFACT)) throw new ImprovementError('sourceRequired')
      const settings = settingsSchema.parse(await dependencies.settings(tx,userId,source))
      if (settings.harness !== source.harness) throw new ImprovementError('sourceMismatch')
      const seed = randomBytes(32).toString('hex'), instance = freezeBenchmarkInstance(seed)
      await tx.query(`INSERT INTO improvement_benchmark_instances(id,"userId","issueId","agentId","repoId","sourceRunId","sourceCommit","definitionDigest","instanceDigest",seed,settings)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
      [randomUUID(),userId,source.issueId,source.agentId,source.deviceRepoId,sourceRunId,source.report.sourceCommit,REPORT_BENCHMARK.digest,instance.digest,seed,JSON.stringify(settings)])
      const { rows: [row] } = await tx.query<Instance>('SELECT * FROM improvement_benchmark_instances WHERE "userId"=$1 AND "sourceRunId"=$2 AND "definitionDigest"=$3', [userId,sourceRunId,REPORT_BENCHMARK.digest])
      return publicInstance(await instanceFor(tx,userId,row.id))
    },existing)
  }
  async function beginEvaluation(userId: string, instanceId: string, proposalId: string, candidateVersionId: string) {
    return transaction(async tx => {
      await tx.query(`SELECT t.id FROM improvement_skill_candidates c JOIN factory_tasks t ON t.id=c."factoryTaskId"
        WHERE c."versionId"=$1 AND c."userId"=$2 AND t."userId"=$2 FOR SHARE OF t`,[candidateVersionId,userId])
      const instance = await instanceFor(tx,userId,instanceId)
      const resolved = await resolveSkillVersion(tx,userId,{issueId:instance.issueId,agentId:instance.agentId,deviceRepoId:instance.repoId},candidateVersionId)
      const m = resolved.metadata
      const { rows: [proposal] } = await tx.query('SELECT * FROM improvement_proposals WHERE id=$1 AND "userId"=$2', [proposalId,userId])
      const { rows: [chronology] } = await tx.query(`SELECT 1 FROM improvement_benchmark_instances i,improvement_proposals p,
        factory_candidates c,improvement_skill_candidates v WHERE i.id=$1 AND p.id=$2 AND c.id=$3 AND v."versionId"=$4
        AND i."createdAt"<p."createdAt" AND i."createdAt"<c."createdAt" AND i."createdAt"<v."createdAt"`,[instanceId,proposalId,m?.candidateId ?? null,candidateVersionId])
      if (!m || m.proposalId !== proposalId || !proposal || proposal.issueId !== instance.issueId || !chronology ||
        proposal.candidate?.signals?.reportQuality?.instanceId!==instance.id || proposal.candidate?.signals?.reportQuality?.instanceDigest!==instance.instanceDigest) throw new ImprovementError('sourceMismatch')
      const scope = { issueId:instance.issueId,agentId:instance.agentId,repoId:instance.repoId,sourceCommit:instance.sourceCommit,factoryTaskId:m.factoryTaskId,candidateId:m.candidateId }
      await tx.query(`INSERT INTO improvement_skill_evaluations(id,"instanceId","userId","proposalId","candidateVersionId",scope)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [randomUUID(),instanceId,userId,proposalId,candidateVersionId,JSON.stringify(scope)])
      const { rows: [evaluation] } = await tx.query<Evaluation>('SELECT * FROM improvement_skill_evaluations WHERE "instanceId"=$1 AND "candidateVersionId"=$2',[instanceId,candidateVersionId])
      await evaluationFor(tx,userId,evaluation.id)
      return evaluation
    })
  }
  async function authorizeEvaluation(tx: PoolClient, userId: string, run: CurrentSkillRun, evaluationId: string, artifact: SkillArtifactRef) {
    const { evaluation,instance } = await evaluationFor(tx,userId,evaluationId)
    const { rows: [assignment] } = await tx.query('SELECT * FROM improvement_benchmark_runs WHERE "runId"=$1 AND "userId"=$2 AND "evaluationId"=$3',[run.id,userId,evaluationId])
    return !!assignment && run.issueId === instance.issueId && run.agentId === instance.agentId && run.deviceRepoId === instance.repoId &&
      assignment.instanceId === instance.id && assignment.arm === 'candidate' && assignment.versionId === evaluation.candidateVersionId &&
      artifact.versionId === evaluation.candidateVersionId && REPORT_BENCHMARK.evaluationCaseIds.includes(assignment.caseId)
  }
  async function benchmarkAssignment(tx: PoolClient,userId: string,runId: string) {
    const { rows: [assignment] } = await tx.query('SELECT * FROM improvement_benchmark_runs WHERE "runId"=$1 AND "userId"=$2',[runId,userId])
    if (!assignment) return undefined
    const instance = assignment.evaluationId ? (await evaluationFor(tx,userId,assignment.evaluationId)).instance : await instanceFor(tx,userId,assignment.instanceId)
    const run = await owned(tx,userId,runId)
    if (run.issueId !== instance.issueId || run.agentId !== instance.agentId || run.deviceRepoId !== instance.repoId ||
      run.baseBranch !== instance.sourceCommit || run.prompt !== buildTask(assignment.caseId,frozen(instance)).prompt) throw new ImprovementError('sourceMismatch')
    return { ...instance.settings,sourceCommit:instance.sourceCommit,benchmarkDigest:instance.instanceDigest,caseId:assignment.caseId }
  }
  async function validateExecution(tx:PoolClient,userId:string,runId:string,execution:unknown) {
    const expected=await benchmarkAssignment(tx,userId,runId)
    if (!expected) {
      if (execution===undefined) return
      throw new ImprovementError('sourceRequired')
    }
    const actual=runExecution.parse(execution)
    // A provider mismatch settles as recorded evidence and cannot pass comparison.
    assertBenchmarkExecution({...actual,observedModel:expected.model},expected)
  }
  async function dispatchNext(userId: string,id: string,training = false) {
    return transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`benchmark:${userId}:${id}`])
      if (!training) await lockEvaluationTask(tx,userId,id)
      const state = training ? {instance:await instanceFor(tx,userId,id),evaluation:null} : await evaluationFor(tx,userId,id)
      const {instance,evaluation} = state
      const { rows: prior } = await tx.query(`SELECT b.*,r.status,r."stopRequestedAt" FROM improvement_benchmark_runs b
        LEFT JOIN agent_runs r ON r.id=b."runId" AND r."userId"=b."userId" WHERE b."instanceId"=$1 AND b."evaluationId" IS NOT DISTINCT FROM $2::uuid`,[instance.id,evaluation?.id ?? null])
      if (prior.some(r => !r.status || r.stopRequestedAt || ['cancelled','failed'].includes(r.status))) throw new ImprovementError('runUnavailable')
      const live = prior.find(r => r.status !== 'succeeded')
      if (live) return {runId:live.runId,status:live.status,complete:false}
      const slots = training ? REPORT_BENCHMARK.trainingCaseIds.map(caseId => ({caseId,arm:'training' as const,versionId:BASELINE_ARTIFACT.versionId})) :
        (['baseline','candidate'] as const).flatMap(arm => REPORT_BENCHMARK.evaluationCaseIds.map(caseId => ({caseId,arm,versionId:arm==='baseline'?BASELINE_ARTIFACT.versionId:evaluation!.candidateVersionId})))
      const slot = slots.find(s => !prior.some(r => r.caseId===s.caseId && r.arm===s.arm))
      if (!slot) return {complete:true}
      const task = buildTask(slot.caseId,frozen(instance))
      const result = await dependencies.queue(tx,userId,{issueId:instance.issueId,agentId:instance.agentId,deviceRepoId:instance.repoId,
        note:`Frozen benchmark ${instance.id} ${slot.arm} ${slot.caseId}`,requestKey:`benchmark:${evaluation?.id ?? instance.id}:${slot.arm}:${slot.caseId}`})
      if (result.replayed) throw new ImprovementError('conflict')
      const updated = await tx.query('UPDATE agent_runs SET kind=$2,"baseBranch"=$3,prompt=$4 WHERE id=$1 AND "userId"=$5 AND status=\'queued\' RETURNING id', [result.runId,'implement',instance.sourceCommit,task.prompt,userId])
      if (updated.rowCount !== 1) throw new ImprovementError('runUnavailable')
      if (slot.arm !== 'candidate') await dependencies.selectBaseline(userId,result.runId,tx)
      await tx.query(`INSERT INTO improvement_benchmark_runs("runId","instanceId","evaluationId","caseId",arm,"versionId","userId") VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [result.runId,instance.id,evaluation?.id ?? null,slot.caseId,slot.arm,slot.versionId,userId])
      if (slot.arm === 'candidate') await dependencies.selectVersion(userId,result.runId,slot.versionId,{purpose:'evaluation',evaluationId:evaluation!.id},tx)
      return {...result,complete:false}
    })
  }
  async function comparisonState(tx:PoolClient,userId:string,evaluationId:string):Promise<ComparisonState> {
      await lockEvaluationTask(tx,userId,evaluationId)
      const {evaluation,instance} = await evaluationFor(tx,userId,evaluationId)
      const {rows} = await tx.query(`SELECT b.*,r.status,r.report,r."sessionId",r."stopRequestedAt",r."finishedAt",r."deviceId",to_jsonb(m) AS mount
        FROM improvement_benchmark_runs b JOIN agent_runs r ON r.id=b."runId" AND r."userId"=b."userId"
        LEFT JOIN improvement_skill_mounts m ON m."runId"=b."runId" AND m."userId"=b."userId" WHERE b."evaluationId"=$1 AND b."userId"=$2 ORDER BY b.arm,b."caseId",b."runId"`,[evaluation.id,userId])
      if (rows.length !== REPORT_BENCHMARK.evaluationCaseIds.length * 2 || (['baseline','candidate'] as const).some(arm =>
        !REPORT_BENCHMARK.evaluationCaseIds.every(caseId => rows.filter(row => row.arm===arm && row.caseId===caseId).length===1)))
        throw new ImprovementError('sourceRequired')
      const arms: {baseline:ReportBenchmarkRun[];candidate:ReportBenchmarkRun[]} = {baseline:[],candidate:[]}
      for (const row of rows) {
        const run = await owned(tx,userId,row.runId)
        await benchmarkAssignment(tx,userId,row.runId)
        const assigned = await assignedSkillForRun(tx,userId,run)
        if (assigned.skillUsage !== 'assigned' || !['baseline','candidate'].includes(row.arm)) throw new ImprovementError('sourceMismatch')
        arms[row.arm as 'baseline'|'candidate'].push(benchmarkEvidence(row,{sourceCommit:instance.sourceCommit,instanceDigest:instance.instanceDigest,
          settings:instance.settings,artifact:assigned.skillArtifact,receiptId:assigned.skillReceipt.id}))
      }
      // Metadata only, bounded identically to the collector. No object storage
      // or provider operation runs with this transaction's locks held.
      const {rows:documents}=await tx.query(`SELECT a.id AS "artifactId",a."runId",a.kind,v.version,v."storageKey",v."inlineContent",v.sha256,v.size,v."createdAt"
        FROM artifacts a JOIN artifact_versions v ON v."artifactId"=a.id
        JOIN agent_runs r ON r.id=a."runId" AND r."userId"=a."userId" AND r."issueId"=a."issueId"
        WHERE a."userId"=$1 AND a."issueId"=$2 AND a."runId"=ANY($3::uuid[]) ORDER BY a.id,v.version LIMIT 101`,
        [userId,instance.issueId,rows.map(row=>row.runId)])
      const {rows:[stored]}=await tx.query('SELECT result,digest FROM improvement_evaluation_results WHERE "evaluationId"=$1',[evaluationId])
      const snapshot:EvaluationComparisonSnapshot={evaluationId,instanceId:instance.id,proposalId:evaluation.proposalId,
        candidateVersionId:evaluation.candidateVersionId,scope:evaluation.scope,instanceDigest:instance.instanceDigest,
        baselineSha256:arms.baseline[0].provenance.artifactDigest,candidateSha256:arms.candidate[0].provenance.artifactDigest,
        evidenceDigest:createHash('sha256').update(JSON.stringify({rows,documents})).digest('hex')}
      return {snapshot,stored:stored??null}
  }
  async function compare(userId:string,evaluationId:string) {
    return compareRegisteredEvaluation(userId,{
      assess:dependencies.assess,
      read:()=>transaction(tx=>comparisonState(tx,userId,evaluationId)),
      commit:(before,record)=>transaction(async tx=>{
        const after=await comparisonState(tx,userId,evaluationId)
        if(digest(after.snapshot)!==digest(before))throw new ImprovementError('sourceMismatch')
        if(after.stored)return currentModelEvaluation(after.stored,after.snapshot)
        await tx.query('INSERT INTO improvement_evaluation_results("evaluationId",result,digest) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[evaluationId,JSON.stringify(record),digest(record)])
        const {rows:[stored]}=await tx.query('SELECT result,digest FROM improvement_evaluation_results WHERE "evaluationId"=$1',[evaluationId])
        return currentModelEvaluation(stored,after.snapshot)
      }),
    })
  }
  async function passingEvaluation(tx:PoolClient,userId:string,proposalId:string,candidateVersionId:string,evaluationId:string) {
    await lockEvaluationTask(tx,userId,evaluationId)
    const {evaluation}=await evaluationFor(tx,userId,evaluationId)
    if (evaluation.proposalId!==proposalId || evaluation.candidateVersionId!==candidateVersionId) throw new ImprovementError('sourceMismatch')
    // Publication/approval never starts model or storage I/O. It only consumes
    // a prior assessed immutable result and checks the current mechanical scope.
    const state=await comparisonState(tx,userId,evaluationId)
    if(!state.stored)throw new ImprovementError('sourceRequired')
    const result=currentModelEvaluation(state.stored,state.snapshot)
    if (!result.passed) throw new ImprovementError('sourceMismatch')
    return {evaluationId,digest:digest(result),result}
  }
  const trainingQuality:FailureQualityProvider = async (tx,userId,sources) => {
    if (!sources.length || new Set(sources.map(source=>source.runId)).size!==sources.length) throw new ImprovementError('sourceRequired')
    const fields:ReportQualitySignals['fields']={command:{missing:0,incorrect:0},exitCode:{missing:0,incorrect:0},commit:{missing:0,incorrect:0},
      environment:{missing:0,incorrect:0},verification:{missing:0,incorrect:0},unknowns:{missing:0,incorrect:0}}
    let identity:Instance|undefined
    const evidence:{runId:string;caseId:string;reportDigest:string}[]=[]
    for (const source of sources) {
      const run=await owned(tx,userId,source.runId)
      const {rows:[score]}=await tx.query('SELECT * FROM improvement_scores WHERE id=$1 AND "userId"=$2 AND "runId"=$3',[source.id,userId,source.runId])
      const {rows:[assignment]}=await tx.query('SELECT * FROM improvement_benchmark_runs WHERE "runId"=$1 AND "userId"=$2',[source.runId,userId])
      if (!score || score.outcome!=='failure' || score.snapshot?.reportDigest!==source.reportDigest || digest(run.report)!==source.reportDigest ||
        !assignment || assignment.arm!=='training' || assignment.evaluationId!==null || assignment.versionId!==BASELINE_ARTIFACT.versionId ||
        !REPORT_BENCHMARK.trainingCaseIds.includes(assignment.caseId)) throw new ImprovementError('sourceMismatch')
      const instance=await instanceFor(tx,userId,assignment.instanceId)
      if (identity && identity.id!==instance.id) throw new ImprovementError('sourceMismatch')
      identity=instance
      await benchmarkAssignment(tx,userId,source.runId)
      const assigned=await assignedSkillForRun(tx,userId,run)
      const {rows:[mount]}=await tx.query('SELECT * FROM improvement_skill_mounts WHERE "runId"=$1 AND "userId"=$2',[source.runId,userId])
      if (assigned.skillUsage!=='assigned') throw new ImprovementError('sourceRequired')
      benchmarkEvidence({...run,runId:run.id,caseId:assignment.caseId,versionId:assignment.versionId,mount},
        {sourceCommit:instance.sourceCommit,instanceDigest:instance.instanceDigest,settings:instance.settings,artifact:assigned.skillArtifact,receiptId:assigned.skillReceipt.id})
      const outcome=evaluateTask(assignment.caseId,run.report.summary,frozen(instance))
      if (outcome.passed) throw new ImprovementError('sourceMismatch')
      let actual:Record<string,unknown>={}
      try {const parsed=JSON.parse(run.report.summary);if(parsed && typeof parsed==='object' && !Array.isArray(parsed))actual=parsed} catch { /* Malformed output has no supported fields. */ }
      const schemaFailure=outcome.errors.some(error=>/schema|bounded/.test(error))
      for(const field of Object.keys(fields) as (keyof typeof fields)[]) {
        if (schemaFailure || outcome.errors.some(error=>error.includes(field))) {
          if (!Object.hasOwn(actual,field) || actual[field]===null) fields[field].missing++
          else fields[field].incorrect++
        }
      }
      evidence.push({runId:source.runId,caseId:assignment.caseId,reportDigest:source.reportDigest})
    }
    return {instanceId:identity!.id,instanceDigest:identity!.instanceDigest,assignmentDigest:digest(evidence.sort((a,b)=>a.runId.localeCompare(b.runId))),fields}
  }
  return {freezeBenchmark,beginEvaluation,authorizeEvaluation,benchmarkAssignment,validateExecution,dispatchNext,compare,passingEvaluation,trainingQuality}
}
