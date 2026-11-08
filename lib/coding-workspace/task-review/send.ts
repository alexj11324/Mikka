import 'server-only'
import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { githubReviewMutation, reviewBatchRequest, taskReviewSubmission, WorkspaceReviewError,
  type DiffSnapshot, type TaskReviewSubmission } from '@mikka/protocol/coding-workspace-review'
import { factoryEventId } from '../../factory/event-id'
import { readRunChain } from '../../run-chain'
import { runChanged } from '../../live/panels'
import { withReviewTransaction, type ReviewActor, type ReviewScope } from '../diff/authority'
import { assertBatchMaskPolicy, batchReceipt, lockReviewBoard, maskedReviewText, readReviewBatch, reviewMasks, type ReviewBatchRow } from '../diff/batch-store'
import { deliverAgentReview, prepareAgentReviewInTransaction } from '../diff/agent-delivery'
import { deliverGitHubReview, prepareGitHubReviewInTransaction } from '../diff/github-delivery'
import { nativeReviewUserGrant } from '../diff/github-write'
import { assertFeedbackFactory, currentReviewFactory, lockReviewFeedbackTarget } from '../diff/feedback-factory'
import { associatedGitHubPull } from '../diff/github'
import { diffDigest } from '../diff/patch'
import { diffFile } from '../diff/service'
import { readDiffSnapshot, readStoredDiffFile } from '../diff/store'
import { taskCommentAnchor } from './anchor'
import { assertCurrentTaskReview, selectedTaskReview, type TaskReviewContext } from './context'
import { freezeAttachedReviewChecks } from './checks'
import { TaskReviewDenied, type TaskReviewHttpInput, type TaskReviewHttpResult } from './http'

const child = z.strictObject({ batchId: z.uuid(), requestId: z.uuid(), expectedRevision: z.number().int().nonnegative() })
const sendPlan = z.strictObject({ version: z.literal(1), id: z.uuid(), submissionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  agent: child, github: child.optional() })
type SendPlan = z.infer<typeof sendPlan>
const conflict = () => new WorkspaceReviewError('workspace_review_conflict')
const outdated = () => new WorkspaceReviewError('workspace_snapshot_outdated')
function requireOwner(actor: ReviewActor, context: TaskReviewContext) {
  if (actor.credential.kind !== 'session' || actor.userId !== context.ownerId || context.scope.identity.ownerId !== actor.userId)
    throw new TaskReviewDenied('not_owner_send')
}
async function assertPull(tx: Pick<PoolClient, 'query'>, scope: ReviewScope, snapshot: DiffSnapshot) {
  let current: Awaited<ReturnType<typeof associatedGitHubPull>> | undefined
  try { current = await associatedGitHubPull(tx, scope) }
  catch (error) { if (!(error instanceof WorkspaceReviewError) || error.code !== 'workspace_snapshot_unavailable') throw error }
  if (current ? current.number !== snapshot.pullRequest?.number || !isDeepStrictEqual(current.factory, snapshot.factory) : Boolean(snapshot.pullRequest)) throw outdated()
}
function agentRequest(plan: SendPlan, row: ReviewBatchRow) {
  const agent = row.input.agent
  if (!agent) throw conflict()
  const factory = agent.factory
  return reviewBatchRequest.parse({ ...plan.agent, snapshotId: row.snapshotId, sourceVersion: row.input.sourceVersion,
    commentIds: row.input.commentIds, note: agent.note, failedCheckRefs: agent.failedCheckRefs,
    ...(factory ? { factory: { taskId: factory.taskId, revision: factory.revision, attemptId: factory.attemptId,
      candidateId: factory.candidateId, sourceEventId: factory.sourceEventId } } : {}) })
}
function githubRequest(plan: SendPlan, row: ReviewBatchRow) {
  const native = row.input.native
  if (!native || native.write.kind !== 'github_review' || !plan.github) throw conflict()
  return githubReviewMutation.parse({ ...plan.github, action: 'publish', sourceVersion: row.input.sourceVersion,
    event: native.write.event, commentIds: row.input.commentIds, note: native.write.note })
}
async function priorPlan(tx: PoolClient, actor: ReviewActor, scope: ReviewScope, requestId: string, fingerprint: string) {
  const { rows: [prior] } = await tx.query<{ action: string; fingerprint: string; response: unknown }>(`SELECT action,fingerprint,response
    FROM coding_workspace_review_receipts WHERE "boardId"=$1 AND "userId"=$2 AND "requestId"=$3`, [scope.boardId, actor.userId, requestId])
  if (!prior) return null
  if (prior.action !== 'task_send' || prior.fingerprint !== fingerprint) throw conflict()
  return sendPlan.parse(prior.response)
}

/** One Task submission freezes local comments and both existing delivery
 * batches in one transaction. Only their established ledgers send effects;
 * a response lost after a GitHub write can never fall back to another POST. */
export async function sendTaskReview(input: TaskReviewHttpInput): Promise<TaskReviewHttpResult> {
  const { workspaceId: _workspaceId, ...raw } = input.input
  const submission: TaskReviewSubmission = taskReviewSubmission.parse(raw), { deps, actor, taskId, request } = input
  const context = await selectedTaskReview(deps, actor, taskId, submission.reviewRef, request.signal)
  requireOwner(actor, context)
  const { runId, repoId } = context.scope.identity, snapshot = context.snapshot
  const { idempotencyKey, ...payload } = submission
  const requestId = factoryEventId('workspace-task-send', JSON.stringify([taskId, actor.userId, idempotencyKey]))
  const fingerprint = diffDigest(JSON.stringify(payload))
  const submissionDigest = diffDigest(JSON.stringify({ ...payload,
    comments: [...payload.comments].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), attachedChecks: [...payload.attachedChecks].sort() }))
  let plan = await withReviewTransaction(deps.database, deps.membership, actor, runId, repoId,
    (tx, scope) => priorPlan(tx, actor, scope, requestId, fingerprint), { signal: request.signal })
  if (!plan) {
    // Fetch/prove every selected file before creating any local comment. The
    // stored full-source policy and anchors are verified again at COMMIT.
    for (const path of new Set(submission.comments.map(comment => comment.path)))
      await diffFile(deps, actor, runId, repoId, snapshot.id, path, request.signal)
    const native = snapshot.pullRequest && snapshot.sourceAccess ? await nativeReviewUserGrant(actor.userId,
      context.scope.identity.repositoryKey, snapshot.sourceAccess.repositoryId, { deadline: Date.now() + 25_000, signal: request.signal }) : undefined
    plan = await withReviewTransaction(deps.database, deps.membership, actor, runId, repoId, async (tx, scope) => {
      const board = await lockReviewBoard(tx, scope)
      const replay = await priorPlan(tx, actor, scope, requestId, fingerprint)
      if (replay) return replay
      const { rows: [duplicate] } = await tx.query<{ response: unknown }>(`SELECT r.response FROM coding_workspace_review_receipts r
        JOIN coding_workspace_review_batches a ON a.id=(r.response->'agent'->>'batchId')::uuid
        LEFT JOIN coding_workspace_review_batches g ON g.id=(r.response->'github'->>'batchId')::uuid
        WHERE r."boardId"=$1 AND r."userId"=$2 AND r.action='task_send' AND r.response->>'submissionDigest'=$3
          AND (g.state IS DISTINCT FROM 'rejected') AND (g.id IS NOT NULL OR a.state<>'rejected')
        ORDER BY r."createdAt",r."requestId" LIMIT 1`, [scope.boardId, actor.userId, submissionDigest])
      if ((await tx.query<{ count: number }>('SELECT count(*)::int AS count FROM coding_workspace_review_receipts WHERE "boardId"=$1', [scope.boardId])).rows[0]!.count >= 49_997)
        throw new CodingWorkspaceError('workspace_limit_exceeded')
      let result: SendPlan
      if (duplicate) result = sendPlan.parse(duplicate.response)
      else {
        await assertCurrentTaskReview(tx, actor, context)
        await assertPull(tx, scope, snapshot)
        const current = await readDiffSnapshot(tx, scope, snapshot.id)
        if (current.revision.version !== submission.reviewRef.sourceVersion || current.availability === 'unavailable') throw outdated()
        const masks = await reviewMasks(actor, scope)
        const checks = await freezeAttachedReviewChecks(tx, actor, scope, current, submission.attachedChecks, masks)
        if ((await tx.query<{ count: number }>('SELECT count(*)::int AS count FROM coding_workspace_review_comments WHERE "boardId"=$1', [scope.boardId])).rows[0]!.count + submission.comments.length > 10_000)
          throw new CodingWorkspaceError('workspace_limit_exceeded')
        const commentIds: string[] = [], files = new Map<string, Awaited<ReturnType<typeof readStoredDiffFile>>>()
        for (const [index, comment] of submission.comments.entries()) {
          let file = files.get(comment.path)
          if (!file) { file = await readStoredDiffFile(tx, scope, current, comment.path, masks[0]!); files.set(comment.path, file) }
          if (!file.patch) throw new WorkspaceReviewError('workspace_review_anchor_invalid')
          const anchor = taskCommentAnchor(file.patch, comment), id = factoryEventId('workspace-task-comment', `${requestId}:${index}`)
          await tx.query(`INSERT INTO coding_workspace_review_comments (id,"boardId","threadId","snapshotId","userId",anchor,body,draft)
            VALUES ($1,$2,$1,$3,$4,$5,$6,true)`, [id, scope.boardId, snapshot.id, actor.userId, anchor, maskedReviewText(comment.body, masks, 4000)])
          commentIds.push(id)
        }
        commentIds.sort()
        const note = maskedReviewText(submission.note?.trim() ?? '', masks, 4000), factory = await currentReviewFactory(tx, scope)
        const agent = { batchId: factoryEventId('workspace-task-agent-batch', requestId), requestId: factoryEventId('workspace-task-agent-request', requestId), expectedRevision: board.revision }
        await prepareAgentReviewInTransaction(tx, actor, scope, reviewBatchRequest.parse({ ...agent, snapshotId: snapshot.id,
          sourceVersion: snapshot.revision.version, commentIds, note, failedCheckRefs: [...submission.attachedChecks].sort(), ...(factory ? { factory } : {}) }))
        result = { version: 1, id: requestId, submissionDigest, agent }
        if (native) {
          await native.verifyCredential!(tx)
          const github = { batchId: factoryEventId('workspace-task-github-batch', requestId), requestId: factoryEventId('workspace-task-github-request', requestId),
            expectedRevision: (await lockReviewBoard(tx, scope)).revision }
          const nativeNote = [note, ...(checks.length ? [`Failed checks for the reviewed commit:\n${JSON.stringify(checks)}`] : [])].filter(Boolean).join('\n\n')
          if (nativeNote.length > 4000) throw new CodingWorkspaceError('workspace_limit_exceeded')
          await prepareGitHubReviewInTransaction(tx, actor, scope, snapshot.id, githubReviewMutation.parse({ ...github, action: 'publish',
            sourceVersion: snapshot.revision.version, event: 'REQUEST_CHANGES', commentIds, note: nativeNote }), native.githubAccountId)
          result.github = github
        }
        await assertBatchMaskPolicy(actor, scope, masks)
      }
      await tx.query(`INSERT INTO coding_workspace_review_receipts ("boardId","userId","requestId",fingerprint,action,response)
        VALUES ($1,$2,$3,$4,'task_send',$5)`, [scope.boardId, actor.userId, requestId, fingerprint, result])
      await runChanged(tx, runId)
      return result
    }, { signal: request.signal, beforeRunLock: tx => lockReviewFeedbackTarget(tx, context.scope) })
  }
  const frozen = plan
  const agent = await readReviewBatch(deps.database, actor, context.scope, frozen.agent.batchId)
  let github = frozen.github ? await readReviewBatch(deps.database, actor, context.scope, frozen.github.batchId) : undefined
  let effectError: CodingWorkspaceError | WorkspaceReviewError | undefined
  try {
  if (github && github.state !== 'accepted' && github.state !== 'rejected') {
    await deliverGitHubReview(deps, actor, runId, repoId, snapshot.id, githubRequest(frozen, github), request.signal, {
      lock: tx => lockReviewFeedbackTarget(tx, context.scope), check: async (tx, scope) => {
        await assertCurrentTaskReview(tx, actor, context)
        await assertFeedbackFactory(tx, scope, agent.input.agent?.factory)
      },
    })
    github = await readReviewBatch(deps.database, actor, context.scope, frozen.github!.batchId)
  }
  if ((!github || github.state === 'accepted') && agent.state === 'prepared')
    await deliverAgentReview(deps, actor, runId, repoId, agentRequest(frozen, agent), request.signal, async (tx, scope) => {
      await assertCurrentTaskReview(tx, actor, context)
      await assertPull(tx, scope, snapshot)
    })
  } catch (error) {
    if (!(error instanceof CodingWorkspaceError) && !(error instanceof WorkspaceReviewError)) throw error
    effectError = error
  }
  const currentAgent = await readReviewBatch(deps.database, actor, context.scope, frozen.agent.batchId)
  if (frozen.github) github = await readReviewBatch(deps.database, actor, context.scope, frozen.github.batchId)
  const accepted = currentAgent.state === 'accepted' && (!github || github.state === 'accepted')
  const refused = currentAgent.state === 'rejected' || github?.state === 'rejected'
  const denied = effectError?.code === 'workspace_review_github_forbidden' || (github?.state === 'rejected' && github.receipt?.reason === 'authorization_changed')
  return { context, status: accepted ? 200 : denied ? 403 : refused ? 409 : 202, render: async (tx, scope) => {
    const agent = await batchReceipt(tx, scope, await readReviewBatch(tx, actor, scope, frozen.agent.batchId))
    const github = frozen.github ? await batchReceipt(tx, scope, await readReviewBatch(tx, actor, scope, frozen.github.batchId)) : null
    const both = agent.state === 'accepted' && (!github || github.state === 'accepted')
    const chain = both && agent.delivery?.runId ? await readRunChain(tx, actor.userId, agent.delivery.runId) : null
    const attempt = chain?.attempts.find(item => item.runId === agent.delivery?.runId)?.attempt
    if (both && (!attempt || !agent.delivery?.messageId)) throw new WorkspaceReviewError('workspace_review_unavailable')
    const rejected = agent.state === 'rejected' || github?.state === 'rejected'
    const blocked = effectError && !['workspace_review_delivery_uncertain', 'workspace_review_github_unavailable'].includes(effectError.code)
    const permission = effectError?.code === 'workspace_review_github_forbidden' || (github?.state === 'rejected' && github.reason === 'authorization_changed')
    const status = both ? 200 : permission ? 403 : rejected || blocked ? 409 : 202
    return { status, body: { submissionId: frozen.id, reviewRef: submission.reviewRef,
      state: both ? 'sent' : github?.state === 'accepted' && agent.state === 'rejected' ? 'partial'
        : rejected ? 'rejected' : blocked ? 'blocked' : 'pending', agent, github,
      ...(!both && permission ? { error: 'github_permission', reason: 'github_permission' }
        : effectError && !both ? { error: effectError.code } : {}),
      ...(both ? { messageId: agent.delivery!.messageId, attempt } : {}) } }
  } }
}
