import 'server-only'
import type { PoolClient } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { reviewBatchRequest, WorkspaceReviewError, type DiffSnapshot, type ReviewBatchReceipt, type ReviewBatchRequest } from '@mikka/protocol/coding-workspace-review'
import { UNFINISHED_RUN_STATUSES } from '../../agent-run-statuses'
import { readRunChain } from '../../run-chain'
import { sendOwnedRunMessageInTransaction } from '../../run-control'
import { notifyDeviceWork } from '../../device-gateway-notify'
import { runChanged } from '../../live/panels'
import { factoryEventId } from '../../factory/event-id'
import { FactoryError } from '../../factory/contract'
import { factoryRuntimeForBot } from '../../factory/runtime'
import { automaticFactoryDispatch } from '../../factory/automatic-dispatch'
import { beginFactoryTransaction, commitFactoryTransaction, rollbackFactoryTransaction, forgetFactoryTransaction } from '../../factory/transaction'
import { ActionFailureError } from '../../action-error'
import { resolveReviewScope, withReviewTransaction, type ReviewActor, type ReviewScope } from './authority'
import { readDiffSnapshot } from './store'
import type { DiffDependencies } from './service'
import { diffDigest } from './patch'
import { assertBatchMaskPolicy, assertBatchSafe, batchReceipt, freezeReviewComments, insertReviewBatch, lockReviewBoard,
  maskedReviewText, priorReviewBatch, readReviewBatch, reviewMasks, settleReviewBatch, type ReviewBatchRow } from './batch-store'
import { reviewFeedbackText } from './feedback'
import { assertFeedbackFactory, freezeReviewFactory, lockReviewFeedbackTarget } from './feedback-factory'
import { reviewSourceWitness } from './feedback-source'
import { associatedGitHubPull } from './github'
import { freezeAttachedReviewChecks } from '../task-review/checks'

const live = (status: string) => UNFINISHED_RUN_STATUSES.some(value => value === status)
const outdated = () => new WorkspaceReviewError('workspace_snapshot_outdated')
function owner(actor: ReviewActor, scope: ReviewScope) {
  if (actor.credential.kind !== 'session' || scope.identity.ownerId !== actor.userId)
    throw new WorkspaceReviewError('workspace_review_unavailable')
}

async function checkReferences(tx: PoolClient, actor: ReviewActor, scope: ReviewScope, snapshot: DiffSnapshot,
  input: ReviewBatchRequest, masks: Awaited<ReturnType<typeof reviewMasks>>) {
  for (const reference of input.failedCheckRefs) {
    if (reference.startsWith('github-check:')) continue
    const [kind, id, extra] = reference.split(':')
    if (extra !== undefined || !z.uuid().safeParse(id).success) throw new CodingWorkspaceError('workspace_invalid_request')
    const result = kind === 'run-report'
      ? await tx.query('SELECT 1 FROM agent_runs WHERE id=$1 AND id=$2 AND "userId"=$3 AND report IS NOT NULL', [id, scope.identity.runId, scope.identity.ownerId])
      : kind === 'run-chunk'
        ? await tx.query('SELECT 1 FROM run_chunks WHERE id=$1 AND "runId"=$2', [id, scope.identity.runId])
        : kind === 'factory-attempt' && input.factory
          ? await tx.query('SELECT 1 FROM factory_attempts WHERE id=$1 AND "taskId"=$2 AND id=$3', [id, input.factory.taskId, input.factory.attemptId])
          : null
    if (!result?.rowCount) throw new WorkspaceReviewError('workspace_review_unavailable')
  }
  return freezeAttachedReviewChecks(tx, actor, scope, snapshot, input.failedCheckRefs.filter(ref => ref.startsWith('github-check:')), masks)
}

/** Shared composition point for the Task's single send transaction. It only
 * freezes the existing batch; the established delivery path owns its effect. */
export async function prepareAgentReviewInTransaction(tx: PoolClient, actor: ReviewActor, scope: ReviewScope, input: ReviewBatchRequest) {
    const { runId, repoId } = scope.identity
  const requestDigest = diffDigest(JSON.stringify(input))
    owner(actor, scope)
    const board = await lockReviewBoard(tx, scope)
    const prior = await priorReviewBatch(tx, actor, scope, input.requestId, requestDigest)
    if (prior) return prior
    const snapshot = await readDiffSnapshot(tx, scope, input.snapshotId)
    if (snapshot.revision.version !== input.sourceVersion || snapshot.availability === 'unavailable') throw outdated()
    const masks = await reviewMasks(actor, scope)
    const comments = await freezeReviewComments(tx, actor, scope, snapshot, input.commentIds, masks)
    const failedChecks = await checkReferences(tx, actor, scope, snapshot, input, masks)
    const factory = await freezeReviewFactory(tx, scope, snapshot, input.factory)
    const note = maskedReviewText(input.note ?? '', masks, 4000)
    const failedCheckRefs = [...new Set(input.failedCheckRefs.map(value => maskedReviewText(value, masks, 2000)))].sort()
    const text = reviewFeedbackText(snapshot, comments, note, failedCheckRefs, failedChecks)
    const row = await insertReviewBatch(tx, actor, scope, snapshot, { id: input.batchId, requestId: input.requestId,
      requestDigest, expectedRevision: input.expectedRevision, destination: 'agent', frozen: {
        version: 1, runId, repoId, sourceVersion: snapshot.revision.version, commentIds: comments.map(comment => comment.id),
        agent: { text, comments, note, failedCheckRefs, ...(failedChecks.length ? { failedChecks } : {}), ...(factory ? { factory } : {}) },
      } }, board.revision)
    await assertBatchMaskPolicy(actor, scope, masks)
    return row
}

async function prepare(deps: DiffDependencies, actor: ReviewActor, runId: string, repoId: string,
  input: ReviewBatchRequest, signal?: AbortSignal) {
  return withReviewTransaction(deps.database, deps.membership, actor, runId, repoId,
    (tx, scope) => prepareAgentReviewInTransaction(tx, actor, scope, input), { signal })
}

export async function readAgentReviewBatch(deps: DiffDependencies, actor: ReviewActor, runId: string, repoId: string,
  batchId: string, signal?: AbortSignal): Promise<ReviewBatchReceipt> {
  return withReviewTransaction(deps.database, deps.membership, actor, runId, repoId, async (tx, scope) => {
    owner(actor, scope)
    const row = await readReviewBatch(tx, actor, scope, batchId)
    if (row.destination !== 'agent') throw new WorkspaceReviewError('workspace_review_unavailable')
    return batchReceipt(tx, scope, row)
  }, { signal })
}

function refusal(error: unknown): ReviewBatchReceipt['reason'] | undefined {
  if (error instanceof WorkspaceReviewError) return ['workspace_snapshot_outdated', 'workspace_review_anchor_invalid', 'workspace_review_conflict'].includes(error.code)
    ? 'source_changed' : error.code === 'workspace_review_github_forbidden' ? 'authorization_changed' : 'target_unavailable'
  if (error instanceof CodingWorkspaceError) return error.code === 'workspace_limit_exceeded' ? 'limit_exceeded'
    : error.code === 'workspace_version_conflict' ? 'source_changed'
      : ['workspace_not_found', 'workspace_path_unavailable'].includes(error.code) ? 'authorization_changed' : 'target_unavailable'
  if (error instanceof FactoryError || error instanceof ActionFailureError) return 'target_unavailable'
  return undefined
}

async function reject(deps: DiffDependencies, actor: ReviewActor, row: ReviewBatchRow, reason: ReviewBatchReceipt['reason'], signal?: AbortSignal) {
  return withReviewTransaction(deps.database, deps.membership, actor, row.input.runId, row.input.repoId, async (tx, scope) => {
    owner(actor, scope); await lockReviewBoard(tx, scope)
    const current = await readReviewBatch(tx, actor, scope, row.id)
    if (current.state !== 'prepared') return batchReceipt(tx, scope, current)
    return settleReviewBatch(tx, scope, current, 'rejected', null, reason)
  }, { signal })
}

/** One complete request joins the existing inbox or Factory queue. There is
 * no secondary dispatcher: queue/message and accepted receipt share COMMIT. */
export async function deliverAgentReview(deps: DiffDependencies, actor: ReviewActor, runId: string, repoId: string,
  raw: unknown, signal?: AbortSignal, guard?: (tx: PoolClient, scope: ReviewScope) => Promise<void>): Promise<ReviewBatchReceipt> {
  if (actor.credential.kind !== 'session') throw new WorkspaceReviewError('workspace_review_unavailable')
  const input = reviewBatchRequest.parse(raw)
  const requestSignal = AbortSignal.any([AbortSignal.timeout(25_000), ...(signal ? [signal] : [])])
  const row = await prepare(deps, actor, runId, repoId, input, requestSignal)
  if (row.state !== 'prepared') return readAgentReviewBatch(deps, actor, runId, repoId, row.id, requestSignal)
  const scope = await resolveReviewScope(deps.database, deps.membership, actor, runId, repoId)
  owner(actor, scope)
  const snapshot = await readDiffSnapshot(deps.database, scope, row.snapshotId)
  let wake: (() => Promise<void>) | undefined
  let receipt: ReviewBatchReceipt
  try {
    const witness = await reviewSourceWitness(deps, actor, scope, snapshot, requestSignal, row.input.agent?.factory)
    receipt = await withReviewTransaction(deps.database, deps.membership, actor, runId, repoId, async (tx, fresh, lease) => {
      owner(actor, fresh)
      await lockReviewBoard(tx, fresh)
      const current = await readReviewBatch(tx, actor, fresh, row.id)
      if (current.state !== 'prepared') return batchReceipt(tx, fresh, current)
      await guard?.(tx, fresh)
      if (!current.input.agent || live(fresh.status) !== live(scope.status)) throw outdated()
      const agent = current.input.agent
      const masks = await reviewMasks(actor, fresh)
      assertBatchSafe(current.input, masks)
      await freezeReviewComments(tx, actor, fresh, snapshot, current.input.commentIds, masks)
      if (witness.checkpointId && !(await tx.query(`SELECT 1 FROM coding_workspace_checkpoint_reviews
        WHERE "runId"=$1 AND "repoId"=$2 AND "snapshotId"=$3 AND reason IS NULL FOR SHARE`, [runId, repoId, witness.checkpointId])).rowCount) throw outdated()
      const task = await assertFeedbackFactory(tx, fresh, agent.factory)
      if (snapshot.pullRequest) {
        await tx.query(`SELECT "runId" FROM run_publications WHERE "runId"=ANY($1::uuid[]) AND "userId"=$2
          AND "issueId"=$3 AND "remoteKey"=$4 FOR SHARE`,
        [[runId, ...(snapshot.factory ? [snapshot.factory.producerRunId] : [])], actor.userId, fresh.taskId, fresh.identity.repositoryKey])
        const association = await associatedGitHubPull(tx, fresh)
        if (association.number !== snapshot.pullRequest.number
          || (snapshot.factory && (association.factory?.candidateId !== snapshot.factory.candidateId
            || association.factory?.producerRunId !== snapshot.factory.producerRunId || association.factory?.sha !== snapshot.factory.sha))) throw outdated()
      }
      let delivery: NonNullable<ReviewBatchReceipt['delivery']>
      const messageId = factoryEventId('workspace-review-message', current.id)
      if (live(fresh.status)) {
        if (fresh.stopped || (await readRunChain(tx, actor.userId, runId))?.latestRunId !== runId) throw outdated()
        if (task && (task.stage !== 'execute' || task.status !== 'running'
          || !(await tx.query('SELECT 1 FROM factory_attempts WHERE id=$1 AND "taskId"=$2 AND "runId"=$3 AND status=\'running\'',
            [task.attemptId, task.id, runId])).rowCount)) throw outdated()
        const deviceId = await sendOwnedRunMessageInTransaction(drizzle(tx), actor.userId, { runId, text: agent.text, messageId })
        wake = async () => { notifyDeviceWork(deviceId) }
        delivery = { kind: 'run_message', id: messageId, runId, ...(snapshot.revision.headSha ? { headSha: snapshot.revision.headSha } : {}) }
      } else if (task) {
        const runtime = factoryRuntimeForBot(task.botId)
        let target = task
        if (target.stage === 'execute' && target.status === 'running') target = (await runtime.store.apply(actor.userId,
          { taskId: target.id, revision: target.revision }, factoryEventId('workspace-review-finish', current.id),
          { action: 'finish', status: 'blocked', reason: 'The owner supplied review feedback after execution ended.', evidence: [], output: {} }, tx)).task
        const repaired = await runtime.store.apply(actor.userId, { taskId: target.id, revision: target.revision },
          factoryEventId('workspace-review-repair', current.id), { action: target.stage === 'execute' ? 'retry' : 'repair',
            reason: `Apply workspace review batch ${current.id}; preserve the original request and exact source.` }, tx)
        await tx.query('UPDATE factory_attempts SET output=output || $2::jsonb WHERE id=$1 AND "taskId"=$3',
          [repaired.task.attemptId, { workspaceReview: { batchId: current.id, fingerprint: current.fingerprint } }, repaired.task.id])
        wake = await automaticFactoryDispatch(deps.database)(tx, runtime.store, repaired.task, { id: runId }) ?? undefined
        const { rows: [queued] } = await tx.query<{ runId: string }>(`SELECT a."runId" FROM factory_attempts a
          JOIN agent_runs r ON r.id=a."runId" AND r."userId"=$3 AND r."issueId"=$4
          WHERE a.id=$1 AND a."taskId"=$2 AND r.status='queued' AND r."agentDefinition"->'workspaceReview'->>'batchId'=$5`,
        [repaired.task.attemptId, repaired.task.id, actor.userId, fresh.taskId, current.id])
        if (!queued || !wake) throw new WorkspaceReviewError('workspace_review_unavailable')
        delivery = { kind: 'factory_repair', id: repaired.task.attemptId, runId: queued.runId,
          ...(snapshot.revision.headSha ? { headSha: snapshot.revision.headSha } : {}) }
      } else {
        const result = await (await import('./feedback-continuation')).queueReviewContinuation(deps, tx, actor, fresh, current)
        wake = result.wake
        delivery = { kind: 'run_continuation', id: result.runId, runId: result.runId,
          ...(snapshot.revision.headSha ? { headSha: snapshot.revision.headSha } : {}) }
      }
      if (delivery.kind !== 'run_message') {
        // The complete request is already in the child's frozen prompt. This
        // existing thread row displays the owner's turn and is never sent to
        // the worker a second time. It commits with queue and batch receipt.
        await tx.query(`INSERT INTO run_messages (id,"runId","userId",text,origin,"mailboxWakeDepth","deliveredAt")
          VALUES ($1,$2,$3,$4,'owner',-1,clock_timestamp())`, [messageId, delivery.runId, actor.userId, agent.text])
        await runChanged(tx, delivery.runId!)
      }
      delivery.messageId = messageId
      await assertBatchMaskPolicy(actor, fresh, masks)
      await lease.check()
      return settleReviewBatch(tx, fresh, current, 'accepted', delivery)
    }, { signal: requestSignal, runLock: 'update', ...(witness.live ? { live: witness.live } : {}),
      beforeRunLock: tx => lockReviewFeedbackTarget(tx, scope), transaction: {
        begin: beginFactoryTransaction,
        commit: (tx, workspace) => commitFactoryTransaction(tx, { ownerId: actor.userId, workspaceId: actor.workspaceId,
          check: async () => { requestSignal.throwIfAborted(); await workspace.query('SELECT 1') } }),
        rollback: rollbackFactoryTransaction, finish: forgetFactoryTransaction,
      } })
  } catch (error) {
    const reason = refusal(error)
    if (reason === 'target_unavailable' && process.env.MIKKA_REVIEW_DEBUG === '1') {
      const detail = error as { code?: string; message?: string; cause?: { code?: string; message?: string } }
      console.error(JSON.stringify({ event: 'review_target_unavailable_debug', name: error instanceof Error ? error.name : typeof error,
        code: detail.code, message: detail.message, causeCode: detail.cause?.code, causeMessage: detail.cause?.message }))
    }
    if (reason && !requestSignal.aborted) return reject(deps, actor, row, reason, requestSignal)
    throw new WorkspaceReviewError('workspace_review_delivery_uncertain', { cause: error })
  }
  await wake?.()
  return receipt
}
