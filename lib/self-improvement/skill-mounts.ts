import type { PoolClient } from 'pg'
import { runSkillMount, type RunSkillMount, type RunReport, type RunStopReason, type RunExecution, type RunRuntime } from '@mikka/protocol/run'
import type { SkillAssignmentReceipt } from '@mikka/protocol/skill'
import { assignedSkillForRun } from './assignments'
import { currentSkillEligibility, lockSkillScope, type SkillEvaluationAuthorization } from './registry'
import { digest, ImprovementError } from './contract'

type ExecutionValidator = (tx: PoolClient, userId: string, runId: string, execution: RunExecution | undefined) => Promise<void>

type MountRun = {
  id: string; userId: string; issueId: string; agentId: string; deviceRepoId: string; deviceId: string
  sessionId: string | null; status: string; stopRequestedAt: Date | null
  startedAt: Date | null; leaseExpiresAt: Date | null
}

/** Completion is accepted while the server still owns the live lease. */
export function assertSkillMountBinding(run: MountRun, userId: string, raw: RunSkillMount,
  receipt: SkillAssignmentReceipt, now: Date) {
  const mount = runSkillMount.parse(raw)
  const mountedAt = Date.parse(mount.mountedAt)
  if (run.userId !== userId || receipt.runId !== run.id || receipt.issueId !== run.issueId ||
    receipt.agentId !== run.agentId || receipt.repoId !== run.deviceRepoId || receipt.deviceId !== run.deviceId ||
    mount.receiptId !== receipt.id || mount.versionId !== receipt.artifact.versionId || mount.sha256 !== receipt.artifact.sha256 ||
    mount.sessionId !== run.sessionId || !run.startedAt || mountedAt < run.startedAt.getTime() ||
    mountedAt < Date.parse(receipt.assignedAt) || mountedAt > now.getTime() ||
    run.stopRequestedAt || !['preparing', 'running', 'waiting_input', 'finishing'].includes(run.status) ||
    !run.leaseExpiresAt || run.leaseExpiresAt.getTime() <= now.getTime())
    throw new ImprovementError('sourceMismatch')
  return mount
}

/** Only the authenticated device completion path can append this ledger. */
export async function recordSkillMount(tx: PoolClient, userId: string, runId: string, mount: RunSkillMount | undefined,
  authorize: (userId: string, issueId: string, tx: PoolClient) => Promise<boolean>,
  authorizeEvaluation?: SkillEvaluationAuthorization, execution?: RunExecution, validateExecution?: ExecutionValidator, runtime?: RunRuntime) {
  if (!mount) return
  const { rows: [source] } = await tx.query('SELECT "issueId","deviceRepoId" FROM agent_runs WHERE id=$1 AND "userId"=$2', [runId, userId])
  if (!source?.issueId) throw new ImprovementError('notFound')
  await tx.query('SELECT id FROM issues WHERE id=$1 FOR SHARE', [source.issueId])
  if (!await authorize(userId, source.issueId, tx)) throw new ImprovementError('notFound')
  await lockSkillScope(tx, userId, source.issueId, source.deviceRepoId)
  const { rows: [run] } = await tx.query(`SELECT r.*,a.harness AS "runtimeHarness" FROM agent_runs r
    JOIN agents a ON a.id=r."agentId" AND a."userId"=$2 AND a."deviceId"=r."deviceId"
    JOIN device_repos repo ON repo.id=r."deviceRepoId" AND repo."userId"=$2 AND repo."deviceId"=r."deviceId"
    JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=$2 AND d.enabled=true
    WHERE r.id=$1 AND r."userId"=$2 FOR UPDATE OF r FOR SHARE OF a,repo,d`, [runId, userId])
  if (!run || run.issueId !== source.issueId) throw new ImprovementError('notFound')
  // A concurrent completion already ended this run; replay cannot mint new evidence.
  if (!['queued', 'preparing', 'running', 'waiting_input', 'finishing'].includes(run.status)) return
  if (runtime && runtime.harness !== run.runtimeHarness) throw new ImprovementError('sourceMismatch')
  const assigned = await assignedSkillForRun(tx, userId, run)
  if (assigned.skillUsage !== 'assigned') throw new ImprovementError('sourceRequired')
  await currentSkillEligibility(tx, userId, run, assigned.skillArtifact, authorizeEvaluation)
  if (execution) {
    if (!validateExecution) throw new ImprovementError('sourceRequired')
    await validateExecution(tx, userId, runId, execution)
  } else if (validateExecution) await validateExecution(tx, userId, runId, undefined)
  const verified = assertSkillMountBinding(run, userId, mount, assigned.skillReceipt, new Date())
  await tx.query(`INSERT INTO improvement_skill_mounts("runId","userId","deviceId","receiptId","versionId",sha256,"sessionId","mountedAt",execution,runtime)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT ("runId") DO NOTHING`,
  [runId, userId, run.deviceId, verified.receiptId, verified.versionId, verified.sha256, verified.sessionId, verified.mountedAt, execution ? JSON.stringify(execution) : null, runtime ? JSON.stringify(runtime) : null])
  const { rows: [stored] } = await tx.query('SELECT * FROM improvement_skill_mounts WHERE "runId"=$1', [runId])
  if (!stored || stored.userId !== userId || stored.deviceId !== run.deviceId || stored.receiptId !== verified.receiptId ||
    stored.versionId !== verified.versionId || stored.sha256 !== verified.sha256 || stored.sessionId !== verified.sessionId ||
    new Date(stored.mountedAt).getTime() !== Date.parse(verified.mountedAt) ||
    digest(stored.execution ?? null) !== digest(execution ?? null) ||
    digest(stored.runtime ?? null) !== digest(runtime ?? null)) throw new ImprovementError('conflict')
}

/** Cancellation/device loss must settle even after lease or authorization revocation. */
export async function recordCompletionSkillMount(tx: PoolClient, userId: string, runId: string,
  stopReason: RunStopReason, report: RunReport | undefined,
  authorize: Parameters<typeof recordSkillMount>[4], authorizeEvaluation?: SkillEvaluationAuthorization, validateExecution?: ExecutionValidator) {
  if ((stopReason === 'cancelled' || stopReason === 'device_lost') && report?.skillMount) {
    const settled = { ...report }
    delete settled.skillMount
    delete settled.execution
    delete settled.runtime
    return settled
  }
  if (report?.runtime && (!report.skillMount || report.sourceCommit !== report.runtime.sourceCommit)) throw new ImprovementError('sourceMismatch')
  if (report?.execution && !report.skillMount) throw new ImprovementError('sourceRequired')
  if (report?.execution && report.sourceCommit !== report.execution.sourceCommit) throw new ImprovementError('sourceMismatch')
  await recordSkillMount(tx, userId, runId, report?.skillMount, authorize, authorizeEvaluation, report?.execution, validateExecution, report?.runtime)
  return report
}
