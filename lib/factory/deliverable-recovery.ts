import type { PoolClient } from 'pg'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { RUN_CHECKPOINT_MAX_BYTES } from '@mikka/protocol'
import { completedRecoveryEvidence, recoveryQuestionIdentityDigest } from './deliverable-snapshot'
import { questionFingerprint } from './questions/contract'
import { factoryRunBotMatches } from './run-scope'
import type { FactoryTask } from './store'

/** Prepared by the authorized task transaction, never accepted from a browser
 * or model. The old checkpoint is an integrity comparator, not a restore input. */
export interface RetainedDeliverableScope {
  ownerId: string
  workspaceId: string
  botId: string | null
  taskId: string
  issueId: string
  sourceEventId: string
  revision: number
  attemptId: string
  candidateId: string
  producerRunId: string
  producerSessionId: string
  producerReportDigest: string
  /** A historical submitted question omitted the host execution purpose.
   * Only a server-successful, unverified delivery may admit its stopped journal. */
  legacyQuestionSubmission?: { questionId: string; continuesRunId: string }
  deviceId: string
  deviceRepoId: string
  repoPath: string
  worktreePath: string
  sourceCommit: string
  machineRunId: string
  sandboxId: string
  machineOperationId: string
  machineSnapshotId: string
  questionId: string
  questionRevision: number
  questionDigest: string
  questionIdentityDigest: string
  completionRecoveryEventId: string
  completionEventId: string
  checkpoint: {
    baseCommit: string
    files: number
    takenAt: string
    updatedAt: string
    compressedSha256: string
    patchSha256: string
    patchBytes: number
  }
}

export interface RetainedDeliverableSnapshot {
  head: string
  tree: string
  diffSha256: string
  diffBytes: number
  clean: true
  observedAt: string
  journalUpdatedAt: string
  producerRunId: string
  sessionId: string
  worktreePath: string
  sandboxId: string
  machineRunId: string
}

/** The observer restores the exact VM to paused before returning. Its lease
 * stays owned until the final task CAS transaction, or release on any failure. */
export interface ObservedRetainedDeliverable {
  snapshot: RetainedDeliverableSnapshot
  leaseId: string
  release(): Promise<void>
}
export type ObserveRetainedDeliverable = (scope: RetainedDeliverableScope) => Promise<ObservedRetainedDeliverable>

export type DeliverableRecoveryTask = Pick<FactoryTask, 'id' | 'userId' | 'issueId' | 'botId' | 'stage' | 'status' | 'revision' | 'attemptId' | 'candidateId' | 'sourceEventId'>
export type DeliverableRecoveryQuery = Pick<PoolClient, 'query'>

export const MAX_RETAINED_DIFF_BYTES = 16 * 1024 * 1024
const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
const iso = (value: string | Date) => new Date(value).toISOString()

/** Read-only eligibility shared by GET, preflight and the final locked CAS.
 * The caller owns task/access locks when needed. No provider I/O or writes. */
export async function retainedDeliverableForRecovery(tx: DeliverableRecoveryQuery, task: DeliverableRecoveryTask, leaseId?: string) {
  if (task.stage !== 'review' || task.status !== 'waiting' || !task.candidateId) return null
  const { rows } = await tx.query(`SELECT to_jsonb(producer) AS producer,to_jsonb(c) AS candidate,to_jsonb(review) AS review,to_jsonb(q) AS question,
      b."workspaceId",repo."repoPath",repo."remoteUrl",m."sandboxId",m."operationId" AS "machineOperationId",m."snapshotId" AS "machineSnapshotId",
      cp."baseCommit" AS "checkpointBase",cp.files AS "checkpointFiles",cp."takenAt" AS "checkpointTakenAt",cp."updatedAt" AS "checkpointUpdatedAt",cp.patch
    FROM factory_tasks t JOIN factory_attempts a ON a.id=t."attemptId" AND a."taskId"=t.id
    JOIN factory_candidates c ON c.id=t."candidateId" AND c."taskId"=t.id
    JOIN agent_runs producer ON producer.id=c."runId" AND producer."userId"=t."userId" AND producer."issueId"=t."issueId"
    JOIN agent_runs review ON review.id=a."runId" AND review."userId"=t."userId" AND review."issueId"=t."issueId"
    JOIN factory_questions q ON q."originRunId"=review.id AND q."taskId"=t.id AND q."userId"=t."userId" AND q."issueId"=t."issueId"
    JOIN computer_run_bindings b ON b."runId"=producer.id AND b."ownerId"=t."userId"
    JOIN computer_run_bindings check_binding ON check_binding."runId"=review.id AND check_binding."ownerId"=b."ownerId" AND check_binding."workspaceId"=b."workspaceId" AND check_binding."botId"=b."botId"
    JOIN bots bot ON bot.id=b."botId" AND bot."ownerId"=b."ownerId" AND bot."workspaceId"=b."workspaceId" AND bot."archivedAt" IS NULL
    JOIN devices d ON d.id=producer."deviceId" AND d."ownerId"=t."userId" AND d.enabled=true AND d.kind='cloud'
    JOIN device_repos repo ON repo.id=producer."deviceRepoId" AND repo."userId"=t."userId" AND repo."deviceId"=d.id
    JOIN thread_machines m ON m."runId"=review.id AND m."ownerId"=t."userId" AND m."workspaceId"=b."workspaceId" AND m."botId"=b."botId" AND m."issueId"=t."issueId"
      AND m."deviceId"=d.id AND m."repoId"=repo.id
    JOIN run_checkpoints cp ON cp."runId"=producer.id AND cp."userId"=t."userId"
    WHERE t.id=$1 AND t."userId"=$2 AND t."issueId"=$3 AND t."attemptId"=$4 AND t."candidateId"=$5 AND t.revision=$6 AND t."sourceEventId"=$7
      AND t.stage='review' AND t.status='waiting' AND a.stage='review' AND a.status='waiting' AND a."candidateId"=c.id
      AND COALESCE(a.output->>'requestEpoch',t."sourceEventId"::text)=t."sourceEventId"::text
      AND c.kind='deliverable' AND c.sha IS NULL AND c.repository=repo."repoPath" AND c.environment='device:'||d.id::text AND c.scope='issue:'||t."issueId"::text
      AND producer.status='succeeded' AND producer."stopReason"='submitted' AND producer."stopRequestedAt" IS NULL AND producer."sessionId" IS NOT NULL
      AND producer.report IS NOT NULL AND producer.report->>'deliverableCommit' IS NULL
      AND producer."questionContinuation"->>'requireSessionResume'='true' AND producer."questionContinuation"->>'originSessionId'=producer."sessionId"
      AND producer."worktreePath" IS NOT NULL AND repo."remoteUrl" IS NULL AND repo."repoPath"='/home/user/.mikka/bot-workspaces/'||b."botId"::text
      AND review.status='stopped' AND review."stopReason"='blocked' AND review."stopRequestedAt" IS NULL AND review."retryOf" IS NULL
      AND review.kind='acceptance' AND review."sessionId"=a."sessionId" AND review."sessionId"<>producer."sessionId"
      AND review."deviceId"=producer."deviceId" AND review."deviceRepoId"=producer."deviceRepoId"
      AND review."baseBranch"=producer.report->>'sourceCommit' AND a.output#>>'{check,sha}'=producer.report->>'sourceCommit'
      AND a.output#>>'{check,candidateId}'=c.id::text AND a.output#>>'{check,stage}'='review'
      AND review.report->>'blockedOn'='mikka.inspect_artifact_unavailable'
      AND q.stage='review' AND q.kind='external' AND q.status IN ('open','waiting_user') AND q."attemptId"=a.id AND q."candidateId"=c.id
      AND q."originSessionId"=review."sessionId" AND q."answerId" IS NULL AND q.answer IS NULL AND q."continuationRunId" IS NULL
      AND q."expiresAt">now() AND q."waitingBinding"->>'revision'=t.revision::text
      AND cp."unavailableReason" IS NULL AND cp."baseCommit"=producer.report->>'sourceCommit' AND cp.files>0 AND octet_length(cp.patch)<=$8
      AND cp."takenAt">=producer."startedAt" AND cp."takenAt"<=producer."finishedAt"
      AND m.state='paused' AND m."sandboxId" IS NOT NULL
      AND (m."templateKind" IN ('desktop','codex','claude') OR (m."templateKind" IS NULL AND m."snapshotId" IN ('desktop','codex','claude')))
      AND (producer."questionContinuation"->>'requiredSandboxId' IS NULL OR producer."questionContinuation"->>'requiredSandboxId'=m."sandboxId")
      AND (($9::uuid IS NULL AND ((m."workerLeaseId" IS NULL AND m."workerLeaseUntil" IS NULL) OR m."workerLeaseUntil"<=now())) OR
        ($9::uuid IS NOT NULL AND m."workerLeaseId"=$9 AND m."workerLeaseUntil">now()))
      AND NOT EXISTS(SELECT 1 FROM agent_runs active WHERE active."deviceId"=d.id AND active.status NOT IN ('succeeded','completed','failed','stopped','cancelled'))
      AND NOT EXISTS(SELECT 1 FROM thread_machines other WHERE other."sandboxId"=m."sandboxId" AND other."runId"<>m."runId" AND other.state<>'ended')
      AND NOT EXISTS(SELECT 1 FROM factory_attempts done WHERE done."taskId"=t.id AND
        (done.stage IN ('approval','publish','monitor') OR (done."candidateId"=c.id AND done.stage IN ('review','verify') AND done.status='passed')))
      AND NOT EXISTS(SELECT 1 FROM factory_approvals approved WHERE approved."taskId"=t.id)
      AND NOT EXISTS(SELECT 1 FROM factory_deliverable_acceptances accepted WHERE accepted."taskId"=t.id)
      AND NOT EXISTS(SELECT 1 FROM factory_publications publication WHERE publication."taskId"=t.id AND publication.status IN ('reserved','uncertain','succeeded'))
      AND NOT EXISTS(SELECT 1 FROM factory_events previous WHERE previous."taskId"=t.id AND previous.request->>'kind'='owner_deliverable_snapshot_recovery' AND previous.result#>>'{snapshotRecovery,candidateId}'=c.id::text)
      AND NOT EXISTS(SELECT 1 FROM factory_questions other WHERE other."taskId"=t.id AND other.id<>q.id AND other.status NOT IN ('resolved','cancelled','expired','superseded'))
      AND NOT EXISTS(SELECT 1 FROM operation_ledger operation JOIN factory_attempts prior ON prior."taskId"=t.id
        AND (prior."runId"=operation."runId" OR prior."runId"::text=operation.binding->>'executionRunId') WHERE operation."ownerId"=t."userId" AND operation.status IN ('executing','uncertain'))
      AND NOT EXISTS(SELECT 1 FROM run_publications publication JOIN factory_attempts prior ON prior."runId"=publication."runId"
        WHERE prior."taskId"=t.id AND publication."userId"=t."userId" AND publication.status='processing')`,
  [task.id, task.userId, task.issueId, task.attemptId, task.candidateId, task.revision, task.sourceEventId, RUN_CHECKPOINT_MAX_BYTES, leaseId ?? null])
  if (rows.length !== 1) return null
  const row = rows[0], producer = row.producer, candidate = row.candidate, review = row.review, question = row.question
  if (!/^[a-f0-9]{40}$/.test(producer.report?.sourceCommit ?? '') ||
    !(await factoryRunBotMatches(tx, task, producer)) || !(await factoryRunBotMatches(tx, task, review)) ||
    question.waitingBinding?.taskId !== task.id || question.waitingBinding?.issueId !== task.issueId ||
    question.waitingBinding?.attemptId !== task.attemptId || question.waitingBinding?.candidateId !== task.candidateId ||
    !Buffer.isBuffer(row.patch)) return null
  const completion = await completedRecoveryEvidence(tx, task, candidate)
  if (!completion) return null
  let patch: Buffer
  try { patch = gunzipSync(row.patch, { maxOutputLength: MAX_RETAINED_DIFF_BYTES }) }
  catch { return null }
  if (!patch.length) return null
  const continuation = producer.questionContinuation
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  const legacyQuestionSubmission = producer.kind === 'implement' && producer.agentDefinition?.readOnly !== true &&
    producer.report.verify?.status === 'not_run' && producer.report.publish?.pushed !== true &&
    continuation?.requireSessionResume === true && continuation.originSessionId === producer.sessionId &&
    typeof continuation.questionId === 'string' && uuid.test(continuation.questionId) &&
    typeof producer.continuesRunId === 'string' && uuid.test(producer.continuesRunId) && producer.continuesRunId !== producer.id
    ? { questionId: continuation.questionId as string, continuesRunId: producer.continuesRunId as string } : undefined
  const scope: RetainedDeliverableScope = {
    ownerId: task.userId, workspaceId: row.workspaceId, botId: task.botId, taskId: task.id, issueId: task.issueId,
    sourceEventId: task.sourceEventId, revision: task.revision, attemptId: task.attemptId, candidateId: candidate.id,
    producerRunId: producer.id, producerSessionId: producer.sessionId, producerReportDigest: questionFingerprint(producer.report),
    ...(legacyQuestionSubmission ? { legacyQuestionSubmission } : {}),
    deviceId: producer.deviceId, deviceRepoId: producer.deviceRepoId, repoPath: row.repoPath, worktreePath: producer.worktreePath,
    sourceCommit: producer.report.sourceCommit, machineRunId: review.id, sandboxId: row.sandboxId,
    machineOperationId: row.machineOperationId, machineSnapshotId: row.machineSnapshotId,
    questionId: question.id, questionRevision: question.revision, questionDigest: questionFingerprint(question),
    questionIdentityDigest: recoveryQuestionIdentityDigest(question),
    completionRecoveryEventId: completion.completionRecoveryEventId, completionEventId: completion.completionEventId,
    checkpoint: { baseCommit: row.checkpointBase, files: row.checkpointFiles, takenAt: iso(row.checkpointTakenAt),
      updatedAt: iso(row.checkpointUpdatedAt), compressedSha256: sha256(row.patch), patchSha256: sha256(patch), patchBytes: patch.length },
  }
  return { scope, producer, candidate, review, question }
}
