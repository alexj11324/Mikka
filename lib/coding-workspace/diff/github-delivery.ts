import 'server-only'
import { isDeepStrictEqual } from 'node:util'
import type { PoolClient } from 'pg'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { githubReviewMutation, WorkspaceReviewError, type DiffSnapshot, type GitHubReviewMutation, type ReviewBatchReceipt } from '@mikka/protocol/coding-workspace-review'
import { createOperationLedger, OperationError, type OperationIntent, type OperationRecord } from '../../operations/ledger'
import { resolveReviewScope, withReviewTransaction, type ReviewActor, type ReviewScope } from './authority'
import { readDiffSnapshot } from './store'
import type { DiffDependencies } from './service'
import { diffDigest } from './patch'
import { associatedGitHubPull } from './github'
import { GitHubWriteRejection } from './github-api'
import { nativeReviewUserGrant, publishNativeGitHubReview, reconcileNativeGitHubReview, type NativeReviewReceipt } from './github-write'
import { assertBatchMaskPolicy, assertBatchSafe, batchReceipt, freezeReviewComments, insertReviewBatch, lockReviewBoard,
  maskedReviewText, priorReviewBatch, readReviewBatch, reviewMasks, settleReviewBatch } from './batch-store'

async function assertAssociation(deps: Pick<DiffDependencies, 'database'>, scope: ReviewScope, snapshot: DiffSnapshot) {
  const current = await associatedGitHubPull(deps.database, scope)
  if (current.number !== snapshot.pullRequest?.number || !isDeepStrictEqual(current.factory, snapshot.factory))
    throw new WorkspaceReviewError('workspace_snapshot_outdated')
}

/** Freeze inside the caller's single Task-send transaction when requested. */
export async function prepareGitHubReviewInTransaction(client: PoolClient, actor: ReviewActor, scope: ReviewScope, snapshotId: string,
  input: GitHubReviewMutation, githubAccountId: string) {
  const { runId, repoId } = scope.identity
  const requestDigest = diffDigest(JSON.stringify([snapshotId, input]))
    const board = await lockReviewBoard(client, scope)
    const prior = await priorReviewBatch(client, actor, scope, input.requestId, requestDigest)
    if (prior) return prior
    const snapshot = await readDiffSnapshot(client, scope, snapshotId)
    if (snapshot.revision.version !== input.sourceVersion || !snapshot.pullRequest || !snapshot.sourceAccess) throw new WorkspaceReviewError('workspace_snapshot_outdated')
    const masks = await reviewMasks(actor, scope)
    const comments = await freezeReviewComments(client, actor, scope, snapshot, input.action === 'publish' ? input.commentIds : [], masks)
    const write = input.action === 'reply' ? { kind: 'github_reply' as const, commentId: input.commentId, body: maskedReviewText(input.body, masks, 4000) }
      : { kind: 'github_review' as const, event: input.event, note: maskedReviewText(input.note, masks, 4000), comments }
    const result = await insertReviewBatch(client, actor, scope, snapshot, { id: input.batchId, requestId: input.requestId, requestDigest, expectedRevision: input.expectedRevision,
      destination: 'github', frozen: { version: 1, runId, repoId, sourceVersion: snapshot.revision.version,
        commentIds: comments.map(item => item.id), native: { githubAccountId, write } } }, board.revision)
    await assertBatchMaskPolicy(actor, scope, masks)
    return result
}

async function prepare(deps: DiffDependencies, actor: ReviewActor, runId: string, repoId: string, snapshotId: string,
  input: GitHubReviewMutation, githubAccountId: string, signal?: AbortSignal) {
  return withReviewTransaction(deps.database, deps.membership, actor, runId, repoId,
    (client, scope) => prepareGitHubReviewInTransaction(client, actor, scope, snapshotId, input, githubAccountId), { signal })
}

export type ReviewDeliveryGuard = { lock: (tx: PoolClient) => Promise<void>; check: (tx: PoolClient, scope: ReviewScope) => Promise<void> }

export async function deliverGitHubReview(deps: DiffDependencies, actor: ReviewActor, runId: string, repoId: string,
  snapshotId: string, raw: unknown, signal?: AbortSignal, guard?: ReviewDeliveryGuard): Promise<ReviewBatchReceipt> {
  if (actor.credential.kind !== 'session') throw new WorkspaceReviewError('workspace_review_unavailable')
  const input = githubReviewMutation.parse(raw)
  const scope = await resolveReviewScope(deps.database, deps.membership, actor, runId, repoId)
  const snapshot = await readDiffSnapshot(deps.database, scope, snapshotId)
  if (!snapshot.pullRequest || !snapshot.sourceAccess || snapshot.revision.version !== input.sourceVersion)
    throw new WorkspaceReviewError('workspace_snapshot_outdated')
  await assertAssociation(deps, scope, snapshot)
  const requestDeadline = Date.now() + 30_000
  const grant = await nativeReviewUserGrant(actor.userId, scope.identity.repositoryKey, snapshot.sourceAccess.repositoryId,
    { deadline: requestDeadline, signal })
  const prepared = await prepare(deps, actor, runId, repoId, snapshotId, input, grant.githubAccountId, signal)
  if (prepared.input.native?.githubAccountId !== grant.githubAccountId) throw new WorkspaceReviewError('workspace_review_github_forbidden')

  // Authentication/refresh preceded this lease. Bound the entire effect phase
  // below the 20s idle transaction limit, and abort its transport with the lease.
  const effectSignal = AbortSignal.any([AbortSignal.timeout(Math.max(1, Math.min(18_000, requestDeadline - Date.now()))), ...(signal ? [signal] : [])])
  return withReviewTransaction(deps.database, deps.membership, actor, runId, repoId, async (authority, fresh, lease) => {
    // Publications are host evidence, not merely preflight metadata. Keep the
    // exact producer's receipt fixed through the provider effect and outcome.
    await authority.query(`SELECT "runId" FROM run_publications WHERE "runId"=ANY($1::uuid[])
      AND "userId"=$2 AND "issueId"=$3 AND "remoteKey"=$4 FOR SHARE`,
    [[runId, ...(snapshot.factory ? [snapshot.factory.producerRunId] : [])], fresh.identity.ownerId, fresh.taskId, fresh.identity.repositoryKey])
    if (snapshot.factory) await authority.query('SELECT id FROM factory_candidates WHERE id=$1 AND "taskId"=$2 FOR SHARE',
      [snapshot.factory.candidateId, snapshot.factory.taskId])
    if (!grant.verifyCredential) throw new WorkspaceReviewError('workspace_review_github_forbidden')
    await grant.verifyCredential(authority)
    const combined = AbortSignal.any([effectSignal, lease.signal])
    grant.client.budget.signal = combined
    grant.client.budget.deadline = Math.min(grant.client.budget.deadline, Date.now() + 18_000)
    await assertAssociation({ database: authority as unknown as DiffDependencies['database'] }, fresh, snapshot)
    const row = await readReviewBatch(authority, actor, fresh, prepared.id)
    if (row.snapshotId !== snapshot.id || row.input.sourceVersion !== snapshot.revision.version || !row.input.native
      || row.input.native.githubAccountId !== grant.githubAccountId) throw new WorkspaceReviewError('workspace_review_conflict')
    if (row.state === 'accepted' || row.state === 'rejected') return batchReceipt(authority, fresh, row)
    const native = row.input.native
    const intent: OperationIntent = { operationId: row.id, ownerId: actor.userId, workspaceId: actor.workspaceId,
      provider: 'github', accountId: grant.githubAccountId, action: native.write.kind,
      target: `repository:${grant.repositoryId}/pull:${snapshot.pullRequest!.number}`, approvalId: row.id,
      proposalDigest: row.fingerprint, payloadDigest: row.fingerprint }
    const key = { operationId: row.id, ownerId: actor.userId, workspaceId: actor.workspaceId }
    let accepted: NativeReviewReceipt | undefined
    let failureReason: ReviewBatchReceipt['reason']
    const authorize = async (client: PoolClient, binding: OperationIntent, executionRunId: string | null, phase: string) => {
      if (executionRunId !== null || !isDeepStrictEqual(binding, intent)) throw new WorkspaceReviewError('workspace_review_conflict')
      await client.query('SELECT mikka_account_assert_writable($1)', [actor.userId])
      await lockReviewBoard(client, fresh)
      const current = await readReviewBatch(client, actor, fresh, row.id)
      if (current.fingerprint !== row.fingerprint || !isDeepStrictEqual(current.input, row.input)) throw new WorkspaceReviewError('workspace_review_conflict')
      if (phase === 'invoke' || phase === 'claim') {
        await guard?.check(authority, fresh)
        const masks = await reviewMasks(actor, fresh)
        assertBatchSafe(row.input, masks)
        // Revalidate the retained full-source proof policy for every anchor.
        await freezeReviewComments(client, actor, fresh, snapshot,
          native.write.kind === 'github_review' ? native.write.comments.map(item => item.id) : [], masks)
        await assertBatchMaskPolicy(actor, fresh, masks)
      }
      if (phase === 'claim') {
        if (!(await client.query(`UPDATE coding_workspace_review_batches SET state='delivering',"updatedAt"=clock_timestamp()
          WHERE id=$1 AND state='prepared'`, [row.id])).rowCount) throw new WorkspaceReviewError('workspace_review_conflict')
      }
    }
    const project = async (client: PoolClient, record: Readonly<OperationRecord>) => {
      if (record.status === 'succeeded') {
        if (!accepted || record.receipt?.providerObjectId !== accepted.id || record.receipt.evidenceDigest !== accepted.evidenceDigest)
          throw new WorkspaceReviewError('workspace_review_delivery_uncertain')
        const { evidenceDigest: _evidence, ...delivery } = accepted
        await settleReviewBatch(client, fresh, row, 'accepted', delivery)
      } else await settleReviewBatch(client, fresh, row, record.status === 'failed' ? 'rejected' : 'uncertain', null,
        record.status === 'failed' ? failureReason ?? 'target_unavailable' : 'delivery_uncertain')
    }
    const ledger = createOperationLedger(deps.database, authorize, { signal: combined,
      guard: async () => ({ signal: lease.signal, check: lease.check, close: async () => {} }), project })
    let record = await ledger.reserve(intent)
    if (record.status === 'reserved') {
      try { record = await ledger.claim(key, null) }
      catch (error) {
        if (!(error instanceof OperationError && error.message === 'operationAlreadyClaimed')
          && !(error instanceof WorkspaceReviewError && error.code === 'workspace_review_conflict')) throw error
        // Another request may have claimed after reserve returned. It owns the
        // invocation; return the canonical durable state without touching it.
        const current = await ledger.read(key)
        if (current.status === 'reserved') throw error
        return batchReceipt(authority, fresh, await readReviewBatch(authority, actor, fresh, row.id))
      }
      let sent = false
      try {
        await ledger.invoke(key, record.attemptToken!, async (_current, beforeSend, invokeSignal) => {
          grant.client.budget.signal = AbortSignal.any([combined, invokeSignal])
          accepted = await publishNativeGitHubReview(grant, snapshot, native.write, row.id, row.fingerprint, async () => {
            await beforeSend()
            await guard?.check(authority, fresh)
            await grant.verifyCredential!(authority)
            await assertAssociation({ database: authority as unknown as DiffDependencies['database'] }, fresh, snapshot)
            await lease.check()
            combined.throwIfAborted()
            sent = true
          })
          return { providerObjectId: accepted.id, providerObjectUrl: accepted.url, evidenceDigest: accepted.evidenceDigest }
        })
      } catch (error) {
        // If the request/lease was lost, the separately committed invocation
        // gate remains executing. A later explicit call may only reconcile.
        // error-cause: a provider transport error may retain the bearer token or review body.
        if (combined.aborted) throw new WorkspaceReviewError('workspace_review_delivery_uncertain')
        const refused = !sent || error instanceof GitHubWriteRejection
        failureReason = error instanceof WorkspaceReviewError && error.code === 'workspace_snapshot_outdated' ? 'source_changed'
          : error instanceof WorkspaceReviewError && error.code === 'workspace_review_github_forbidden' ? 'authorization_changed' : 'target_unavailable'
        try { await ledger.settle(key, record.attemptToken!, { status: refused ? 'failed' : 'uncertain' }) }
        catch (cause) { throw new WorkspaceReviewError('workspace_review_delivery_uncertain', { cause }) }
        if (refused && (error instanceof CodingWorkspaceError || error instanceof WorkspaceReviewError)) throw error
      }
    } else if (record.status === 'executing' || record.status === 'uncertain') {
      await ledger.reconcile(key, async () => {
        accepted = await reconcileNativeGitHubReview(grant, snapshot, native.write, row.id, row.fingerprint) ?? undefined
        return accepted ? { providerObjectId: accepted.id, providerObjectUrl: accepted.url, evidenceDigest: accepted.evidenceDigest } : null
      })
      // Negative readback cannot prove that a concurrent owner has not yet
      // sent its first request. Preserve its invocation gate and pending state.
    }
    await lease.check()
    return batchReceipt(authority, fresh, await readReviewBatch(authority, actor, fresh, row.id))
  }, { signal: effectSignal, beforeRunLock: async client => {
    await guard?.lock(client)
    if (snapshot.factory) await client.query('SELECT id FROM factory_tasks WHERE id=$1 AND "userId"=$2 FOR SHARE',
      [snapshot.factory.taskId, snapshot.identity.ownerId])
  } })
}
