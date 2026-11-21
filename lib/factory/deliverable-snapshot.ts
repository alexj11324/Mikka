import type { PoolClient } from 'pg'
import { FactoryError, factoryFlowVersion } from './contract'
import { factoryEventId } from './event-id'
import { questionFingerprint } from './questions/contract'
import type { RetainedDeliverableScope, RetainedDeliverableSnapshot } from './deliverable-recovery'

type Query = Pick<PoolClient, 'query'>
type Scope = { id: string; userId: string; issueId: string }
type Candidate = { id: string; taskId: string; runId: string; kind?: string; sha: string | null; repository: string; environment: string; scope: string }
const commit = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

/** currentView may later persist superseded/expired status. That normal
 * lifecycle does not rewrite the question's identity, answer or request. */
export function recoveryQuestionIdentityDigest(question: Record<string, unknown>) {
  return questionFingerprint(Object.fromEntries(Object.entries(question).filter(([key]) => !['status', 'reason', 'revision', 'updatedAt'].includes(key))))
}

/** sourceCommit is the checkpoint baseline. It is never a delivery snapshot. */
export function reportedCandidateShaSql(candidate = 'c', producer = 'producer') {
  if (![candidate, producer].every(alias => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(alias))) throw new Error('Invalid internal SQL alias')
  return `CASE WHEN ${candidate}.kind='deliverable' THEN ${producer}.report->>'deliverableCommit' ELSE COALESCE(${candidate}.sha,${producer}.report->>'sourceCommit') END`
}

/** The original receipt stays immutable, including when the next Review was
 * blocked after successful execution was consumed. A later snapshot recovery
 * may project its report references only after proving a predecessor relation. */
export async function completedRecoveryEvidence(tx: Query, task: Scope, candidate: Pick<Candidate, 'id' | 'runId'>) {
  const { rows } = await tx.query(`SELECT a.id,a.stage,a.status,r.id AS "runId",r."sessionId",
      completion.request->'change'->'evidence' AS evidence,receipt."eventId" AS "completionRecoveryEventId",completion."eventId" AS "completionEventId",
      receipt.request->'input'->'binding'->'revision' AS "ownerRevision",completion.request->'binding'->'revision' AS "completionRevision"
    FROM factory_tasks t JOIN factory_candidates c ON c."taskId"=t.id AND c.id=$5
    JOIN agent_runs r ON r.id=c."runId" AND r."userId"=t."userId" AND r."issueId"=t."issueId"
    JOIN factory_attempts a ON a."taskId"=t.id AND a."runId"=r.id AND a.stage='execute'
    JOIN factory_events receipt ON receipt."taskId"=t.id AND receipt.request->>'kind'='owner_completion_recovery'
    JOIN factory_events completion ON completion."taskId"=t.id AND completion."eventId"=$4
    WHERE t.id=$1 AND t."userId"=$2 AND t."issueId"=$3 AND r.id=$6
      AND a.status='blocked' AND a."candidateId" IS NULL AND a.output->'watchdog'->>'reasonCode'='recovery_exhausted'
      AND COALESCE(a.output->>'requestEpoch',t."sourceEventId"::text)=t."sourceEventId"::text
      AND a.output->'watchdog'->>'requestEpoch'=t."sourceEventId"::text
      AND r.status='succeeded' AND r."stopReason"='submitted' AND r."stopRequestedAt" IS NULL AND r."sessionId" IS NOT NULL
      AND receipt.request->>'sourceEventId'=t."sourceEventId"::text AND receipt.request->>'attemptId'=a.id::text AND receipt.request->>'runId'=r.id::text
      AND receipt.request#>>'{input,binding,taskId}'=t.id::text AND receipt.request#>>'{input,change,action}'='retry'
      AND receipt.result#>>'{task,id}'=t.id::text AND receipt.result#>>'{task,userId}'=t."userId" AND receipt.result#>>'{task,issueId}'=t."issueId"::text
      AND receipt.result#>>'{task,sourceEventId}'=t."sourceEventId"::text AND receipt.result#>>'{task,candidateId}'=c.id::text
      AND (receipt.result#>>'{task,stage}'='review' OR (t.route->>'flowVersion'='2' AND receipt.result#>>'{task,route,flowVersion}'='2'
        AND (receipt.result#>>'{task,stage}'='approval' OR (receipt.result#>>'{task,stage}'='execute'
          AND receipt.result#>>'{task,status}'='blocked' AND receipt.result#>>'{refusal,code}'='factory_public_evidence_required'))))
      AND (receipt.result#>>'{task,status}' IN ('pending','running')
        OR (receipt.result#>>'{task,stage}'='review' AND receipt.result#>>'{task,status}'='blocked')
        OR (receipt.result#>>'{task,stage}'='execute' AND receipt.result#>>'{task,status}'='blocked' AND receipt.result#>>'{refusal,code}'='factory_public_evidence_required'))
      AND completion.request#>>'{binding,taskId}'=t.id::text AND completion.request#>>'{change,action}'='finish'
      AND completion.request#>>'{change,status}'='passed' AND completion.request#>>'{change,output,runId}'=r.id::text
      AND completion.result#>>'{task,id}'=t.id::text AND completion.result#>>'{task,userId}'=t."userId" AND completion.result#>>'{task,issueId}'=t."issueId"::text
      AND completion.result#>>'{task,sourceEventId}'=t."sourceEventId"::text AND completion.result#>>'{task,candidateId}'=c.id::text
      AND completion.result#>>'{task,attemptId}'=a.id::text AND completion.result#>>'{task,stage}'='execute' AND completion.result#>>'{task,status}'='passed'`,
    [task.id, task.userId, task.issueId, factoryEventId('run-completion', candidate.runId), candidate.id, candidate.runId])
  const row = rows[0]
  if (rows.length !== 1 || !Number.isInteger(row.ownerRevision) || row.ownerRevision < 1 ||
    row.completionRevision !== row.ownerRevision + 1 || !Array.isArray(row.evidence)) return null
  return row
}

export function snapshotMatchesScope(scope: RetainedDeliverableScope, snapshot: RetainedDeliverableSnapshot) {
  return !!scope?.checkpoint && !!snapshot && commit(snapshot.head) && commit(snapshot.tree) && snapshot.head !== scope.sourceCommit &&
    snapshot.clean === true && digest(snapshot.diffSha256) && snapshot.diffSha256 === scope.checkpoint.patchSha256 &&
    snapshot.diffBytes === scope.checkpoint.patchBytes && snapshot.producerRunId === scope.producerRunId &&
    snapshot.sessionId === scope.producerSessionId && snapshot.worktreePath === scope.worktreePath &&
    snapshot.sandboxId === scope.sandboxId && snapshot.machineRunId === scope.machineRunId &&
    Number.isFinite(Date.parse(snapshot.observedAt)) && Number.isFinite(Date.parse(snapshot.journalUpdatedAt)) &&
    Date.parse(snapshot.journalUpdatedAt) <= Date.parse(snapshot.observedAt)
}

/** Only this host-written receipt can supply a missing legacy delivery SHA.
 * Browser/model finish data, old checkpoint bytes and an arbitrary HEAD cannot. */
export async function readDeliverableSnapshotReceipt(tx: Query, task: Scope, candidateId: string) {
  const { rows: receipts } = await tx.query(`SELECT receipt."eventId",receipt.request,receipt.result,receipt."createdAt"
    FROM factory_events receipt JOIN factory_tasks t ON t.id=receipt."taskId"
    WHERE t.id=$1 AND t."userId"=$2 AND t."issueId"=$3
      AND receipt.request->>'kind'='owner_deliverable_snapshot_recovery'
      AND receipt.result#>>'{snapshotRecovery,candidateId}'=$4`, [task.id, task.userId, task.issueId, candidateId])
  if (!receipts.length) return null
  const fail = (): never => { throw new FactoryError('factoryDeliverableSnapshotUnavailable') }
  if (receipts.length !== 1) fail()
  const receipt = receipts[0], request = receipt.request, result = receipt.result
  const scope = request?.scope as RetainedDeliverableScope | undefined
  const snapshot = result?.snapshotRecovery?.snapshot as RetainedDeliverableSnapshot | undefined
  if (!scope || !snapshot || !snapshotMatchesScope(scope, snapshot)) fail()
  const { rows: [row] } = await tx.query(`SELECT t."sourceEventId",t.route,to_jsonb(c) AS candidate,to_jsonb(previous) AS previous,
      producer.id AS "producerRunId",producer."sessionId",producer.report,producer."worktreePath",producer."deviceId",producer."deviceRepoId",
      producer.status,producer."stopReason",producer."stopRequestedAt",repo."repoPath",repo."remoteUrl",
      q.id AS "questionId",q.revision AS "questionRevision",to_jsonb(q) AS question
    FROM factory_tasks t JOIN factory_candidates c ON c."taskId"=t.id AND c.id=$4
    JOIN factory_candidates previous ON previous."taskId"=t.id AND previous.id=$5
    JOIN agent_runs producer ON producer.id=c."runId" AND producer."userId"=t."userId" AND producer."issueId"=t."issueId"
    JOIN device_repos repo ON repo.id=producer."deviceRepoId" AND repo."userId"=t."userId" AND repo."deviceId"=producer."deviceId"
    JOIN factory_questions q ON q.id=$6 AND q."taskId"=t.id AND q."userId"=t."userId" AND q."issueId"=t."issueId"
    WHERE t.id=$1 AND t."userId"=$2 AND t."issueId"=$3`,
  [task.id, task.userId, task.issueId, candidateId, scope!.candidateId, scope!.questionId])
  const candidate = row?.candidate as Candidate | undefined, previous = row?.previous as Candidate | undefined
  const savedCandidate = Array.isArray(result.candidates) ? result.candidates.find((c: Candidate) => c.id === candidateId) as Candidate | undefined : undefined
  if (!row || !candidate || !previous || candidate.id === previous.id || candidate.kind !== 'deliverable' || previous.kind !== 'deliverable' ||
    candidate.sha !== null || previous.sha !== null || candidate.runId !== previous.runId ||
    ['repository', 'environment', 'scope'].some(key => candidate[key as keyof Candidate] !== previous[key as keyof Candidate]) ||
    scope!.taskId !== task.id || scope!.ownerId !== task.userId || scope!.issueId !== task.issueId || scope!.sourceEventId !== row.sourceEventId ||
    scope!.candidateId !== previous.id || scope!.producerRunId !== candidate.runId || scope!.producerRunId !== row.producerRunId ||
    scope!.producerSessionId !== row.sessionId || scope!.producerReportDigest !== questionFingerprint(row.report) ||
    scope!.sourceCommit !== row.report?.sourceCommit || row.report?.deliverableCommit != null || !commit(scope!.sourceCommit) ||
    scope!.repoPath !== row.repoPath || row.remoteUrl !== null || candidate.repository !== row.repoPath ||
    candidate.environment !== `device:${row.deviceId}` || candidate.scope !== `issue:${task.issueId}` ||
    scope!.worktreePath !== row.worktreePath || scope!.deviceId !== row.deviceId || scope!.deviceRepoId !== row.deviceRepoId ||
    row.status !== 'succeeded' || row.stopReason !== 'submitted' || row.stopRequestedAt ||
    scope!.questionId !== row.questionId || row.questionRevision < scope!.questionRevision ||
    scope!.questionIdentityDigest !== recoveryQuestionIdentityDigest(row.question) ||
    request.input?.binding?.taskId !== task.id || request.input?.binding?.revision !== scope!.revision || request.input?.change?.action !== 'retry' ||
    !Number.isInteger(scope!.revision) || scope!.revision < 1 ||
    result.task?.id !== task.id || result.task?.userId !== task.userId || result.task?.issueId !== task.issueId ||
    result.task?.sourceEventId !== scope!.sourceEventId || result.task?.candidateId !== candidate.id ||
    !(result.task?.stage === 'review' || (factoryFlowVersion(row) === 2 && factoryFlowVersion(result.task) === 2 && result.task?.stage === 'approval')) ||
    !['pending', 'running'].includes(result.task?.status) || result.task?.revision <= scope!.revision ||
    result.task?.attemptId === scope!.attemptId ||
    !savedCandidate || (['id', 'taskId', 'sha', 'repository', 'environment', 'scope', 'runId', 'kind'] as const).some(key => savedCandidate[key] !== candidate[key]) ||
    Date.parse(snapshot!.observedAt) > new Date(receipt.createdAt).getTime() + 60_000) fail()
  const completion = await completedRecoveryEvidence(tx, task, previous!)
  if (!completion || completion.completionRecoveryEventId !== scope!.completionRecoveryEventId || completion.completionEventId !== scope!.completionEventId) fail()
  return { eventId: receipt.eventId as string, scope: scope!, snapshot: snapshot!, previous: previous!, completion,
    receiptDigest: questionFingerprint({ request, result }) }
}

/** All check preparation, claim, observation and repair paths share this
 * resolver. A delivery with neither a daemon snapshot nor a valid recovery
 * receipt fails closed instead of silently checking its pre-execution tree. */
export async function resolveFactoryCandidateSha(tx: Query, task: Scope,
  candidate: { id: string; kind?: string }, reportedSha: unknown): Promise<string | null> {
  if (candidate.kind !== 'deliverable') return commit(reportedSha) ? reportedSha : null
  const receipt = await readDeliverableSnapshotReceipt(tx, task, candidate.id)
  if (receipt) return receipt.snapshot.head
  return commit(reportedSha) ? reportedSha : null
}
