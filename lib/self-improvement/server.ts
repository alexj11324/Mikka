import 'server-only'
import { createHash } from 'node:crypto'
import { drizzle } from 'drizzle-orm/node-postgres'
import { runRuntime } from '@mikka/protocol/run'
import { runPolicyDigestInput, type RunPolicy } from '@mikka/protocol/agent-policy'
import { invokeDecision } from '../coordinator/decide'
import { getArtifactObject } from '../artifacts/storage'
import { createSkillComparisonCollector } from './comparison-collector'
import { createRegisteredSkillEvaluator } from './registered-evaluation'
import { pool } from '@/lib/db'
import { issueForUser } from '@/lib/issue-access'
import { queueFactoryRun } from '@/lib/agent-runs'
import { lockCliRunPolicy, lockCliTaskScope } from '@/lib/agent-tool-approval/policy-store'
import { createImprovementStore } from './store'
import { createSkillAssignments } from './assignments'
import { factoryStore, dispatchFactoryRun } from '../factory/server'
import { createSkillRegistry } from './registry'
import { createImprovementFactoryBridge } from './factory-bridge'
import { createSkillEvaluations } from './evaluations'
import { digest, ImprovementError } from './contract'
import { REPORT_BENCHMARK } from './report-benchmark'
import { TeamSkillStore } from './team-skills'

const authorize: Parameters<typeof createSkillAssignments>[1] = async (userId, issueId, tx) =>
  Boolean(await issueForUser(userId, issueId, false, drizzle(tx)))
// Same existing read-only policy as Factory verification, frozen for both arms.
export const benchmarkPolicy:RunPolicy = {
  readOnly:true, networkAllow:[], permissions:{install_dependency:'deny',write_outside_repo:'deny',git_push:'deny',network:'ask'},
}
export const loadSkillComparison=createSkillComparisonCollector(pool,
  async(userId,issueId)=>Boolean(await issueForUser(userId,issueId,false,drizzle(pool))),getArtifactObject)
const evaluateSkillEffect=createRegisteredSkillEvaluator({loadComparison:loadSkillComparison,invokeDecision,
  // Real benchmark/model evaluation is explicitly OFF for this delivery.
  modelEvaluationEnabled:false})
export const skillEffectEvaluator: typeof evaluateSkillEffect = async (userId, proposal) => {
  const tx = await pool.connect()
  let taskScope: Awaited<ReturnType<typeof lockCliTaskScope>>
  try { taskScope = await lockCliTaskScope(tx, userId, proposal.issueId) }
  finally { tx.release() }
  const [{ hostedBillingScope }, { executionWorkspace }] = await Promise.all([import('../abuse/context'), import('../execution-settings')])
  const workspaceId = taskScope.workspaceId ?? await executionWorkspace(userId, null)
  return hostedBillingScope.run({ workspaceId, ownerId: userId }, () => evaluateSkillEffect(userId, proposal))
}
export const skillRegistry = createSkillRegistry(pool, authorize)
export const teamSkillStore = new TeamSkillStore(pool)
export const skillAssignments:ReturnType<typeof createSkillAssignments> = createSkillAssignments(pool, authorize,
  (...args)=>skillEvaluations.authorizeEvaluation(...args))
export const skillEvaluations:ReturnType<typeof createSkillEvaluations> = createSkillEvaluations(pool, {
  authorize,
  assess:skillEffectEvaluator,
  queue:(tx,userId,input,sourceRunId)=>queueFactoryRun(tx,userId,input,null,undefined,sourceRunId),
  lockQueuePolicy:async(tx,userId,sourceRunId)=>{await lockCliRunPolicy(tx,sourceRunId,userId)},
  lockQueueOrigin:(tx,userId,issueId,sourceRunId)=>skillAssignments.lockQuestion(userId,issueId,sourceRunId,tx),
  selectBaseline:(...args)=>skillAssignments.selectBaseline(...args),
  selectVersion:(...args)=>skillAssignments.selectVersion(...args),
  settings:async(tx,userId,source)=>{
    const {rows:[mount]}=await tx.query(`SELECT m.*,r.report,r."sessionId" AS "runSessionId" FROM improvement_skill_mounts m
      JOIN agent_runs r ON r.id=m."runId" AND r."userId"=m."userId" WHERE m."runId"=$1 AND m."userId"=$2`,[source.id,userId])
    const runtime=runRuntime.safeParse(mount?.runtime)
    if (!mount || !runtime.success || !runtime.data.observedModel || runtime.data.harness!==source.harness ||
      runtime.data.sourceCommit!==source.report.sourceCommit || mount.sessionId!==mount.runSessionId ||
      digest(mount.report?.runtime)!==digest(runtime.data)) throw new ImprovementError('sourceRequired')
    return {harness:runtime.data.harness,model:runtime.data.observedModel,
      policyDigest:createHash('sha256').update(runPolicyDigestInput(benchmarkPolicy)).digest('hex'),
      fixtureDigest:createHash('sha256').update(runtime.data.sourceCommit).digest('hex'),verifyCommand:REPORT_BENCHMARK.verifyCommand}
  },
})
export const improvementStore = createImprovementStore(pool, authorize, (...args)=>skillEvaluations.trainingQuality(...args))
export const improvementFactory = createImprovementFactoryBridge(pool, factoryStore, dispatchFactoryRun, skillAssignments,
  (...args)=>skillEvaluations.trainingQuality(...args))

/** Read after the actual claim CAS; current device, lease and frozen configuration remain required. */
export async function claimBenchmarkAssignment(userId:string,deviceId:string,runId:string,leaseExpiresAt:string) {
  const tx=await pool.connect()
  try {
    await tx.query('BEGIN')
    const frozen=await skillEvaluations.benchmarkAssignment(tx,userId,runId)
    if (!frozen) {await tx.query('COMMIT');return undefined}
    const {rows:[run]}=await tx.query(`SELECT id FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "deviceId"=$3
      AND status='preparing' AND "stopRequestedAt" IS NULL AND "leaseExpiresAt"=$4 AND "leaseExpiresAt">now() FOR SHARE`,[runId,userId,deviceId,leaseExpiresAt])
    if (!run || frozen.policyDigest!==createHash('sha256').update(runPolicyDigestInput(benchmarkPolicy)).digest('hex'))
      throw new ImprovementError('runUnavailable')
    const {harness,model,verifyCommand,sourceCommit,benchmarkDigest,caseId,fixtureDigest,policyDigest}=frozen
    await tx.query('COMMIT')
    return {harness,model,policy:benchmarkPolicy,verifyCommand,baseBranch:sourceCommit,
      benchmark:{sourceCommit,benchmarkDigest,caseId,fixtureDigest,policyDigest}}
  } catch(error) {await tx.query('ROLLBACK');throw error} finally {tx.release()}
}
