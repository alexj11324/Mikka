import 'server-only'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Pool } from 'pg'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { diffFilePatch, diffSnapshot, WorkspaceReviewError, type DiffFileMetadata, type DiffFilePatch,
  type DiffSelection, type DiffSnapshot } from '@mikka/protocol/coding-workspace-review'
import { maskDeep, type Masker } from '../../secrets/mask'
import { secretMaskerFor } from '../../secrets/runtime'
import { resolveRunWorktree } from '../identity'
import { requestWorkspaceRead, workspaceResultMaskPolicy } from '../requests'
import { resolveReviewScope, withReviewTransaction, type ReviewActor, type ReviewScope } from './authority'
import { latestDiffSnapshot, manifestRevision, readDiffSnapshot, readDiffFilePage, readStoredDiffFile, retainDiffFilePatch, retainDiffSnapshot } from './store'
import type { ObservedPullState } from './github-state'

export interface ExternalDiffProvider {
  capture(scope: ReviewScope, selection: Extract<DiffSelection, { source: 'commit' | 'pull_request' }>, mask: Masker): Promise<Parameters<typeof retainDiffSnapshot>[2]>
  verify(scope: ReviewScope, snapshot: DiffSnapshot): Promise<void | { isStale: boolean }>
  pullState?(scope: ReviewScope, snapshot: DiffSnapshot): Promise<ObservedPullState>
  file(scope: ReviewScope, snapshot: DiffSnapshot, file: DiffFileMetadata, mask: Masker): Promise<DiffFilePatch>
}

export type DiffDependencies = { database: Pool; membership: Pool; external?: ExternalDiffProvider }

export async function ensureReviewScope(deps: DiffDependencies, actor: ReviewActor, runId: string, repoId: string, signal?: AbortSignal) {
  try { return await resolveReviewScope(deps.database, deps.membership, actor, runId, repoId) }
  catch (error) { if (!(error instanceof CodingWorkspaceError) || error.code !== 'workspace_not_found') throw error }
  try {
    return await withReviewTransaction(deps.database, deps.membership, actor, runId, repoId, async (_client, scope) => scope,
      { historical: true, signal })
  } catch (error) { if (!(error instanceof CodingWorkspaceError) || error.code !== 'workspace_not_found') throw error }
  const live = await resolveRunWorktree(deps.database, deps.membership, actor, runId, repoId)
  return withReviewTransaction(deps.database, deps.membership, actor, runId, repoId, async (_client, scope) => scope, { live: live.identity, signal })
}

function unavailableSnapshot(scope: ReviewScope, source: 'working' | 'checkpoint' | 'commit' | 'pull_request',
  reason: NonNullable<DiffSnapshot['reason']>, evidence?: { baseSha: string; headSha?: string | null; treeSha?: string | null; capturedAt: Date }): DiffSnapshot {
  const revision = manifestRevision(source, evidence?.baseSha ?? null, evidence?.headSha ?? null, evidence?.treeSha ?? null, [])
  return diffSnapshot.parse({ id: randomUUID(), identity: scope.identity, taskId: scope.taskId, revision,
    observedAt: evidence?.capturedAt.toISOString() ?? new Date().toISOString(), isStale: true, availability: 'unavailable', reason,
    counts: { files: 0, additions: 0, deletions: 0, complete: false }, policy: source === 'working' ? 'combined_working_tree'
      : source === 'checkpoint' ? 'retained_checkpoint' : source === 'commit' ? 'explicit_commits' : 'whole_pull_request', pullRequest: null })
}

async function checkpoint(deps: DiffDependencies, scope: ReviewScope): Promise<DiffSnapshot> {
  const { rows: [current] } = await deps.database.query<{
    snapshotId: string | null; baseSha: string; headSha: string | null; treeSha: string | null; capturedAt: Date; reason: DiffSnapshot['reason'];
  }>(`SELECT "snapshotId","baseSha","headSha","treeSha","capturedAt",reason FROM coding_workspace_checkpoint_reviews
    WHERE "runId"=$1 AND "repoId"=$2 AND "workspaceId"=$3`, [scope.identity.runId, scope.identity.repoId, scope.identity.workspaceId])
  if (current?.snapshotId && !current.reason) return { ...await readDiffSnapshot(deps.database, scope, current.snapshotId), observedAt: current.capturedAt.toISOString() }
  if (current) return unavailableSnapshot(scope, 'checkpoint', current.reason ?? 'missing_evidence', current)
  const { rows: [legacy] } = await deps.database.query<{ baseSha: string; capturedAt: Date; reason: string | null }>(
    'SELECT "baseCommit" AS "baseSha","takenAt" AS "capturedAt","unavailableReason" AS reason FROM run_checkpoints WHERE "runId"=$1 AND "userId"=$2',
    [scope.identity.runId, scope.identity.ownerId])
  // A legacy gzip patch has no full-source proof or capture HEAD. Never expose
  // it through this API, even when an old Changes panel displayed it directly.
  return unavailableSnapshot(scope, 'checkpoint', legacy?.reason === 'too_large' ? 'too_large' : 'missing_evidence', legacy)
}

export async function captureDiffSnapshot(deps: DiffDependencies, actor: ReviewActor, runId: string, repoId: string,
  selection: DiffSelection, signal?: AbortSignal): Promise<DiffSnapshot> {
  const scope = await ensureReviewScope(deps, actor, runId, repoId, signal)
  const mask = await secretMaskerFor({ workspaceId: scope.identity.workspaceId, ownerId: scope.identity.ownerId })
  const liveSource = selection.source === 'working' || selection.source === 'auto' || selection.source === 'commit'
  if (liveSource && actor.userId === scope.identity.ownerId) {
    try {
      const result = await requestWorkspaceRead(deps.database, deps.membership, actor, runId, repoId, selection.source === 'commit'
        ? { kind: 'diff_snapshot', ...selection } : { kind: 'diff_snapshot', source: 'working' }, signal)
      if (!result.ok) throw new CodingWorkspaceError(result.code)
      if (result.kind !== 'diff_snapshot') throw new WorkspaceReviewError('workspace_snapshot_unavailable')
      return await withReviewTransaction(deps.database, deps.membership, actor, runId, repoId, async (client, fresh) => {
        const latestMask = await secretMaskerFor({ workspaceId: fresh.identity.workspaceId, ownerId: fresh.identity.ownerId })
        const snapshot = await retainDiffSnapshot(client, fresh, { revision: result.revision, files: result.files }, latestMask)
        return { ...snapshot, isStale: false }
      }, { live: result.identity, signal })
    } catch (error) {
      if (!(error instanceof CodingWorkspaceError) || !['workspace_not_found', 'workspace_machine_unavailable', 'workspace_checkout_unavailable',
        'workspace_unsupported', 'workspace_request_expired'].includes(error.code) || selection.source === 'working') throw error
    }
  } else if (selection.source === 'working') throw new CodingWorkspaceError('workspace_not_found')
  let retained: DiffSnapshot | undefined
  if (selection.source === 'auto' || selection.source === 'checkpoint') {
    retained = await checkpoint(deps, scope)
    if (retained.availability !== 'unavailable' || selection.source === 'checkpoint') return retained
  }
  if (deps.external) {
    try {
      const input = await deps.external.capture(scope, selection.source === 'commit' ? selection : { source: 'pull_request' }, mask)
      return await withReviewTransaction(deps.database, deps.membership, actor, runId, repoId,
        async (client, fresh) => {
          const latestMask = await secretMaskerFor({ workspaceId: fresh.identity.workspaceId, ownerId: fresh.identity.ownerId })
          if (input.patches?.size && (!mask.sourcePolicy || mask.sourcePolicy !== latestMask.sourcePolicy))
            throw new CodingWorkspaceError('workspace_path_unavailable')
          return retainDiffSnapshot(client, fresh, input, latestMask)
        }, { signal })
    } catch (error) {
      if (selection.source !== 'auto' || !(error instanceof WorkspaceReviewError)
        || !['workspace_review_github_unavailable', 'workspace_review_github_forbidden', 'workspace_snapshot_unavailable'].includes(error.code)) throw error
    }
  }
  return retained ?? unavailableSnapshot(scope, selection.source === 'commit' ? 'commit' : 'pull_request', 'github_unavailable')
}

export async function diffPage(deps: DiffDependencies, actor: ReviewActor, runId: string, repoId: string, input: {
  snapshotId?: string; selection?: DiffSelection; cursor?: string; limit?: number; unreviewed?: boolean;
}, signal?: AbortSignal) {
  let snapshot = input.snapshotId ? await readDiffSnapshot(deps.database,
    await resolveReviewScope(deps.database, deps.membership, actor, runId, repoId), input.snapshotId)
    : await captureDiffSnapshot(deps, actor, runId, repoId, input.selection ?? { source: 'auto' }, signal)
  const scope = await resolveReviewScope(deps.database, deps.membership, actor, runId, repoId)
  if (snapshot.sourceAccess || snapshot.pullRequest) {
    if (!deps.external) throw new WorkspaceReviewError('workspace_review_github_unavailable')
    const verified = await deps.external.verify(scope, snapshot)
    if (verified) snapshot = { ...snapshot, isStale: verified.isStale }
  }
  // Remote waits happen above. Resolve and lock membership, task visibility
  // and the real credential again before returning any retained projection.
  return withReviewTransaction(deps.database, deps.membership, actor, runId, repoId, async (client, fresh) => {
    if (!isDeepStrictEqual(snapshot.identity, fresh.identity) || snapshot.taskId !== fresh.taskId)
      throw new CodingWorkspaceError('workspace_not_found')
    const page = snapshot.availability === 'unavailable'
      ? { snapshot, boardRevision: (await client.query<{ revision: number }>(
        'SELECT revision FROM coding_workspace_review_boards WHERE id=$1', [fresh.boardId])).rows[0]?.revision ?? 0, files: [], nextCursor: null }
      : await readDiffFilePage(client, fresh, { ...await readDiffSnapshot(client, fresh, snapshot.id),
        isStale: snapshot.isStale, observedAt: snapshot.observedAt }, actor.userId, input)
    const mask = await secretMaskerFor({ workspaceId: fresh.identity.workspaceId, ownerId: fresh.identity.ownerId })
    if (!isDeepStrictEqual(maskDeep(page, mask), page)) throw new CodingWorkspaceError('workspace_path_unavailable')
    return page
  }, { signal })
}

export async function diffFile(deps: DiffDependencies, actor: ReviewActor, runId: string, repoId: string,
  snapshotId: string, path: string, signal?: AbortSignal): Promise<DiffFilePatch> {
  const scope = await resolveReviewScope(deps.database, deps.membership, actor, runId, repoId)
  const snapshot = await readDiffSnapshot(deps.database, scope, snapshotId)
  if (snapshot.sourceAccess || snapshot.pullRequest) {
    if (!deps.external) throw new WorkspaceReviewError('workspace_review_github_unavailable')
    await deps.external.verify(scope, snapshot)
  }
  const { current, mask } = await withReviewTransaction(deps.database, deps.membership, actor, runId, repoId, async (client, fresh) => {
    const currentSnapshot = await readDiffSnapshot(client, fresh, snapshotId)
    const mask = await secretMaskerFor({ workspaceId: fresh.identity.workspaceId, ownerId: fresh.identity.ownerId })
    return { current: await readStoredDiffFile(client, fresh, currentSnapshot, path, mask), mask }
  }, { signal })
  if (current.patch) return current.patch
  let patch: DiffFilePatch
  let verifiedPolicy = mask.sourcePolicy
  if ((snapshot.sourceAccess || snapshot.pullRequest) && deps.external) patch = await deps.external.file(scope, snapshot, current.file, mask)
  else if (['working', 'commit'].includes(snapshot.revision.source) && scope.identity.ownerId === actor.userId) {
    const result = await requestWorkspaceRead(deps.database, deps.membership, actor, runId, repoId,
      { kind: 'diff_file', snapshotId, revision: snapshot.revision, file: current.file }, signal)
    if (!result.ok) throw new CodingWorkspaceError(result.code)
    if (result.kind !== 'diff_file') throw new WorkspaceReviewError('workspace_snapshot_unavailable')
    verifiedPolicy = workspaceResultMaskPolicy(result)
    patch = diffFilePatch.parse({ snapshotId, sourceVersion: result.sourceVersion, file: result.file, format: result.format, patch: result.patch, hunks: result.hunks })
  } else return { snapshotId, sourceVersion: snapshot.revision.version, file: current.file, format: 'unavailable', patch: null, hunks: [] }
  return withReviewTransaction(deps.database, deps.membership, actor, runId, repoId,
    async (client, fresh) => {
      const latestMask = await secretMaskerFor({ workspaceId: fresh.identity.workspaceId, ownerId: fresh.identity.ownerId })
      if (!verifiedPolicy || verifiedPolicy !== latestMask.sourcePolicy) throw new CodingWorkspaceError('workspace_path_unavailable')
      return retainDiffFilePatch(client, fresh, await readDiffSnapshot(client, fresh, snapshotId), patch, latestMask, verifiedPolicy)
    }, { signal })
}

export { latestDiffSnapshot }
