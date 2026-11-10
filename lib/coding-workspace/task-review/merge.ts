import 'server-only'
import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { taskReviewRef, WorkspaceReviewError } from '@mikka/protocol/coding-workspace-review'
import { bindingSchema, FactoryError } from '../../factory/contract'
import { factoryEventId } from '../../factory/event-id'
import { factoryAuthorize } from '../../factory/authorize'
import { factoryHumanStore } from '../../factory/server'
import { createFactoryMerges, FactoryMergeRefused, githubMergeApi, type AcceptResult, type FactoryMergeBoundary } from '../../factory/merge'
import { lockFactoryHostDispatch } from '../../factory/task-dispatch'
import { githubTokenForUser, GitHubAccessError } from '../../github/user-access'
import type { RequestBudget } from '../../request-budget'
import { withReviewTransaction, type ReviewScope } from '../diff/authority'
import { lockReviewBoard, reviewMasks } from '../diff/batch-store'
import { diffDigest } from '../diff/patch'
import { associatedGitHubPull, readGitHubPull } from '../diff/github'
import { nativeReviewUserGrant } from '../diff/github-write'
import { assertCurrentTaskReview, selectedTaskReview } from './context'
import { readNativeReviewChecks, type ObservedReviewChecks } from './github-checks'
import { TaskReviewDenied, type TaskReviewHttpInput, type TaskReviewHttpResult } from './http'

export const taskReviewMergeRequest = z.strictObject({ reviewRef: taskReviewRef, binding: bindingSchema,
  expectedHeadSha: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/), idempotencyKey: z.string().min(1).max(200),
  confirmFailedChecks: z.boolean(), confirmedChecksFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional() })
  .refine(value => value.confirmFailedChecks === Boolean(value.confirmedChecksFingerprint))
const outdated = () => new WorkspaceReviewError('workspace_snapshot_outdated')
type MergeReceipt = { id: string; taskId: string; candidateId: string; userId: string; eventId: string; sha: string; headSha: string | null;
  mergeCommitSha: string | null; status: 'merging' | 'merged' | 'failed'; code: string | null; pullRequestUrl: string }

/** The existing Factory merge receipt is the only completion fact. In
 * particular an external merge of another HEAD is not this review's approval. */
export function taskMergeReceipt(row: MergeReceipt, expected: { taskId: string; candidateId: string; headSha: string }) {
  if (row.taskId !== expected.taskId || row.candidateId !== expected.candidateId || row.sha !== expected.headSha) throw outdated()
  const reviewedHeadMerged = row.status === 'merged' && row.headSha === expected.headSha
  return { mergeId: row.id, state: row.status === 'merged' ? reviewedHeadMerged ? 'merged' : 'merged_elsewhere'
    : row.status === 'merging' ? 'pending' : 'rejected', merged: row.status === 'merged', reviewedHeadMerged,
  pullRequestUrl: row.pullRequestUrl, expectedHeadSha: expected.headSha, actualHeadSha: row.headSha,
  mergeCommitSha: row.mergeCommitSha, ...(row.code ? { error: row.code } : {}) }
}

export async function mergeTaskReview(input: TaskReviewHttpInput): Promise<TaskReviewHttpResult> {
  const { workspaceId: _workspaceId, ...raw } = input.input, value = taskReviewMergeRequest.parse(raw)
  const { deps, actor, taskId, request } = input
  const context = await selectedTaskReview(deps, actor, taskId, value.reviewRef, request.signal), snapshot = context.snapshot
  if (actor.credential.kind !== 'session' || actor.userId !== context.ownerId || actor.userId !== context.scope.identity.ownerId)
    throw new TaskReviewDenied('not_owner_merge')
  if (value.binding.issueId !== taskId || !snapshot.factory || !snapshot.pullRequest || !snapshot.sourceAccess
    || snapshot.revision.source !== 'pull_request' || snapshot.factory.taskId !== value.binding.taskId
    || snapshot.factory.candidateId !== value.binding.candidateId || snapshot.revision.headSha !== value.expectedHeadSha
    || snapshot.factory.sha !== value.expectedHeadSha) throw outdated()
  const { runId, repoId } = context.scope.identity, candidateId = snapshot.factory.candidateId
  const eventId = factoryEventId('workspace-task-merge', JSON.stringify([taskId, actor.userId, value.idempotencyKey]))
  const fingerprint = diffDigest(JSON.stringify(value))
  const expected = { taskId: value.binding.taskId, candidateId, headSha: value.expectedHeadSha }
  async function requestReceipt(tx: PoolClient, scope: ReviewScope) {
    const { rows: [prior] } = await tx.query<{ fingerprint: string; action: string }>(`SELECT fingerprint,action FROM coding_workspace_review_receipts
      WHERE "boardId"=$1 AND "userId"=$2 AND "requestId"=$3`, [scope.boardId, actor.userId, eventId])
    if (prior && (prior.action !== 'task_merge' || prior.fingerprint !== fingerprint)) throw new WorkspaceReviewError('workspace_review_conflict')
    return prior
  }
  async function existing(tx: Pick<PoolClient, 'query'>): Promise<MergeReceipt | undefined> {
    return (await tx.query<MergeReceipt>(`SELECT * FROM factory_merges WHERE "taskId"=$1 AND "userId"=$2
      AND ("eventId"=$3 OR ("candidateId"=$4 AND status IN ('merging','merged')))
      ORDER BY ("eventId"=$3) DESC,"createdAt" DESC LIMIT 1`, [value.binding.taskId, actor.userId, eventId, candidateId])).rows[0]
  }
  const prior = await withReviewTransaction(deps.database, deps.membership, actor, runId, repoId, async (tx, scope) => {
    const receipt = await requestReceipt(tx, scope)
    return receipt ? existing(tx) : undefined
  }, { signal: request.signal })
  const renderReceipt = (receipt: MergeReceipt): TaskReviewHttpResult => ({ context, render: async (tx, scope) => {
    await requestReceipt(tx, scope)
    const row = (await tx.query<MergeReceipt>('SELECT * FROM factory_merges WHERE id=$1 AND "userId"=$2', [receipt.id, actor.userId])).rows[0]
    if (!row) throw outdated()
    const body = taskMergeReceipt(row, expected)
    const permission = ['githubMergeAuthorizationRequired', 'githubMergeForbidden'].includes(row.code ?? '')
    return { status: body.state === 'merged' ? 200 : body.state === 'pending' ? 202 : permission ? 403 : 409,
      body: { ...body, reviewRef: value.reviewRef, ...(permission ? { error: 'github_permission', reason: 'github_permission' } : {}) } }
  } })
  if (prior && prior.status !== 'merging') return renderReceipt(prior)

  const budget: RequestBudget = { deadline: Date.now() + 55_000, signal: request.signal }
  let credential: Awaited<ReturnType<typeof githubTokenForUser>>
  try { credential = await githubTokenForUser(actor.userId, { minValidityMs: 60_000, budget }) }
  catch (error) {
    if (prior) return renderReceipt(prior)
    if (error instanceof GitHubAccessError) {
      if (!['githubUnavailable', 'githubNotConfigured'].includes(error.code)) throw new TaskReviewDenied('github_permission', { cause: error })
      throw new WorkspaceReviewError('workspace_review_github_unavailable', { cause: error })
    }
    throw error
  }
  const grant = await nativeReviewUserGrant(actor.userId, context.scope.identity.repositoryKey, snapshot.sourceAccess.repositoryId, budget, credential)
  let gate: { status: number; body: Record<string, unknown> } | undefined
  const confirm = (observation: ObservedReviewChecks) => {
    if (observation.headSha !== value.expectedHeadSha) throw outdated()
    const changed = value.confirmFailedChecks && value.confirmedChecksFingerprint !== observation.fingerprint
    if (observation.counts.pending > 0) gate = { status: 409, body: { error: 'workspace_review_unavailable', state: 'checks_pending',
      reviewRef: value.reviewRef, expectedHeadSha: value.expectedHeadSha, checks: observation.counts, checksFingerprint: observation.fingerprint } }
    else if (observation.counts.failed > 0 && (!value.confirmFailedChecks || changed)) gate = { status: 409, body: {
      error: 'needs_confirm', state: 'needs_confirm', failing: observation.counts.failed, reviewRef: value.reviewRef,
      binding: value.binding, expectedHeadSha: value.expectedHeadSha, checksFingerprint: observation.fingerprint,
    } }
    else if (changed) gate = { status: 409, body: { error: 'workspace_snapshot_outdated', state: 'checks_changed', reviewRef: value.reviewRef } }
    if (gate) throw new FactoryMergeRefused('githubMergeBlocked', snapshot.pullRequest!.url)
  }
  const observe = async () => {
    const current = await readGitHubPull(grant, snapshot.pullRequest!.number)
    if (current.head.sha !== value.expectedHeadSha || current.base.sha !== snapshot.pullRequest!.baseSha) throw outdated()
    const observation = await readNativeReviewChecks(grant, value.expectedHeadSha, await reviewMasks(actor, context.scope))
    const after = await readGitHubPull(grant, snapshot.pullRequest!.number)
    if (after.head.sha !== current.head.sha || after.base.sha !== current.base.sha || after.state !== current.state || after.merged !== current.merged) throw outdated()
    return observation
  }
  let observed: ObservedReviewChecks | undefined
  if (!prior) {
    try { observed = await observe(); confirm(observed) }
    catch (error) {
      if (!gate) throw error
      return { context, render: async (tx) => {
        await assertCurrentTaskReview(tx, actor, context)
        return gate!
      } }
    }
  }
  const lock = async (tx: PoolClient) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['task-thread', actor.userId, taskId])])
    await lockFactoryHostDispatch(tx, actor.userId, taskId)
    await factoryHumanStore.lockTask(tx, actor.userId, value.binding.taskId)
  }
  const assertTarget = async (tx: PoolClient, scope: ReviewScope) => {
    await assertCurrentTaskReview(tx, actor, context)
    const { rows: [target] } = await tx.query<{ revision: number; attemptId: string; candidateId: string; stage: string; status: string }>(`SELECT t.revision,t."attemptId",t."candidateId",t.stage,t.status
      FROM factory_tasks t JOIN factory_candidates c ON c.id=t."candidateId" AND c."taskId"=t.id
      JOIN run_publications p ON p."runId"=c."runId" AND p."userId"=t."userId" AND p."issueId"=t."issueId"
      WHERE t.id=$1 AND t."userId"=$2 AND t."issueId"=$3 AND c.id=$4 AND c.sha=$5 AND c."runId"=$6 AND p."remoteKey"=$7
        AND p.status='published' FOR SHARE OF c,p`, [value.binding.taskId, actor.userId, taskId, candidateId, value.expectedHeadSha,
      snapshot.factory!.producerRunId, scope.identity.repositoryKey])
    if (!target || target.revision !== value.binding.revision || target.attemptId !== value.binding.attemptId
      || target.candidateId !== candidateId || target.stage !== 'approval' || !['pending', 'waiting'].includes(target.status)) throw outdated()
    const association = await associatedGitHubPull(tx, scope)
    if (association.number !== snapshot.pullRequest!.number || !isDeepStrictEqual(association.factory, snapshot.factory)) throw outdated()
    if (!grant.verifyCredential) throw new TaskReviewDenied('github_permission')
    await grant.verifyCredential(tx)
  }
  const boundary: FactoryMergeBoundary = {
    preserveUnknown: true,
    claim: work => withReviewTransaction(deps.database, deps.membership, actor, runId, repoId, async (tx, scope) => {
      await lockReviewBoard(tx, scope)
      const replay = await requestReceipt(tx, scope)
      const result = await work(tx)
      if (!replay) {
        if ((await tx.query<{ count: number }>('SELECT count(*)::int AS count FROM coding_workspace_review_receipts WHERE "boardId"=$1', [scope.boardId])).rows[0]!.count >= 50_000)
          throw new CodingWorkspaceError('workspace_limit_exceeded')
        await tx.query(`INSERT INTO coding_workspace_review_receipts ("boardId","userId","requestId",fingerprint,action,response)
          VALUES ($1,$2,$3,$4,'task_merge',$5)`, [scope.boardId, actor.userId, eventId, fingerprint, { eventId }])
      }
      return result
    }, { signal: request.signal, beforeRunLock: lock }),
    beforeInsert: async (tx, _task, pull) => {
      await assertTarget(tx, context.scope)
      if (pull.sha !== value.expectedHeadSha || pull.number !== snapshot.pullRequest!.number || pull.repo.toLowerCase() !== grant.fullName.toLowerCase()
        || pull.url.toLowerCase() !== snapshot.pullRequest!.url.toLowerCase() || !observed) throw outdated()
      confirm(observed)
    },
    existing: async (_tx, row) => {
      if (row.userId !== actor.userId) throw new CodingWorkspaceError('workspace_not_found')
      taskMergeReceipt(row as MergeReceipt, expected)
    },
    effect: async (mergeId, _pull, invoke) => {
      const previous = { ...budget }
      const signal = AbortSignal.any([AbortSignal.timeout(18_000), request.signal])
      try {
        return await withReviewTransaction(deps.database, deps.membership, actor, runId, repoId, async (tx, scope, lease) => {
          budget.signal = AbortSignal.any([signal, lease.signal]); budget.deadline = Math.min(previous.deadline, Date.now() + 18_000)
          await assertTarget(tx, scope)
          const { rows: [receipt] } = await tx.query<MergeReceipt>('SELECT * FROM factory_merges WHERE id=$1 FOR SHARE', [mergeId])
          if (!receipt || receipt.status !== 'merging' || receipt.eventId !== eventId || receipt.userId !== actor.userId) throw outdated()
          taskMergeReceipt(receipt, expected)
          confirm(await observe())
          await grant.verifyCredential!(tx); await lease.check()
          budget.signal.throwIfAborted()
          return invoke()
        }, { signal, beforeRunLock: lock })
      } finally { budget.deadline = previous.deadline; budget.signal = previous.signal }
    },
  }
  const merges = createFactoryMerges(deps.database, factoryAuthorize, factoryHumanStore, githubMergeApi(fetch, budget))
  let result: AcceptResult | undefined, refused: FactoryMergeRefused | undefined
  try { result = await merges.accept({ userId: actor.userId, sessionId: actor.credential.id }, { binding: value.binding, eventId }, credential.token, boundary) }
  catch (error) {
    if (gate) return { context, render: async () => ({ ...gate!, body: { ...gate!.body, newIntentRequired: true } }) }
    if (error instanceof FactoryMergeRefused) refused = error
    else if (error instanceof FactoryError) throw new WorkspaceReviewError('workspace_review_conflict', { cause: error })
    else throw error
  }
  if (result?.status === 'accepted') throw outdated()
  const receipt = result ? (await deps.database.query<MergeReceipt>('SELECT * FROM factory_merges WHERE id=$1 AND "userId"=$2', [result.mergeId, actor.userId])).rows[0]
    : await existing(deps.database)
  if (receipt) return renderReceipt(receipt)
  if (refused && ['githubMergeAuthorizationRequired', 'githubMergeForbidden'].includes(refused.code)) throw new TaskReviewDenied('github_permission')
  throw new WorkspaceReviewError('workspace_review_unavailable', { cause: refused })
}
