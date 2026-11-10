import 'server-only'
import type { Pool } from 'pg'
import { CodingWorkspaceError, type WorkspaceReadRequest } from '@mikka/protocol/coding-workspace'
import {
  WORKSPACE_GIT_OPERATION_TTL_MS, WORKSPACE_GIT_UNDO_TTL_MS, WorkspaceGitError,
  type GitRevertApplied, type GitRevertFile, type GitRevertPreviewInternal, type GitRevertTarget, type GitUndone,
} from '@mikka/protocol/coding-workspace-git'
import type { DiffFileMetadata, DiffRevision } from '@mikka/protocol/coding-workspace-review'
import { maskCheckpoint } from '../../secrets/checkpoint'
import { secretMaskerFor } from '../../secrets/runtime'
import { runChanged } from '../../live/panels'
import { requestWorkspaceRead } from '../requests'
import { resolveReviewScope, withReviewTransaction, type ReviewActor } from '../diff/authority'
import { readDiffSnapshot, readSnapshotFileMetadata } from '../diff/store'
import { gitDigest } from './evidence'
import {
  claimOperation, claimUndo, finishOperation, finishUndo, insertPreview, latestUndoable, releaseOperation,
  releaseUndoClaim, type GitOperationRow,
} from './ops'

export type GitDependencies = { database: Pool; membership: Pool }
const retryable = (error: unknown) => error instanceof CodingWorkspaceError
  && ['workspace_machine_unavailable', 'workspace_checkout_unavailable', 'workspace_request_expired'].includes(error.code)

function requestFile(file: DiffFileMetadata): GitRevertFile | null {
  if (file.previousPath !== null || !['added', 'modified', 'deleted'].includes(file.status) || file.github
    || file.unavailableReason || (file.rawBlob !== undefined && file.rawSize === undefined)
    || !['100644', '100755'].includes(file.oldMode ?? '100644')
    || !['100644', '100755'].includes(file.newMode ?? '100644')) return null
  return { path: file.path, previousPath: null, status: file.status as GitRevertFile['status'],
    oldBlob: file.oldBlob, newBlob: file.newBlob, oldMode: file.oldMode as GitRevertFile['oldMode'],
    newMode: file.newMode as GitRevertFile['newMode'], oldSize: file.oldSize ?? null, newSize: file.newSize ?? null,
    binary: file.binary, fileVersion: file.fileVersion,
    ...(file.rawBlob && file.rawSize !== undefined ? { rawBlob: file.rawBlob, rawSize: file.rawSize } : {}) }
}

/** Preview is a read plus a durable confirmation token. It is bound to the
 * exact retained snapshot the person reviewed and the exact current fences. */
export async function previewRevert(dependencies: GitDependencies, actor: ReviewActor, runId: string, repoId: string,
  input: { operationId: string; snapshotId: string; path: string; target: GitRevertTarget }, signal?: AbortSignal): Promise<GitRevertPreviewInternal> {
  const scope = await resolveReviewScope(dependencies.database, dependencies.membership, actor, runId, repoId)
  const snapshot = await readDiffSnapshot(dependencies.database, scope, input.snapshotId)
  if (snapshot.revision.source !== 'working' || !snapshot.revision.baseSha || !snapshot.revision.headSha)
    throw new WorkspaceGitError('workspace_git_revert_unsupported')
  const file = requestFile(await readSnapshotFileMetadata(dependencies.database, scope, snapshot, input.path))
  if (!file) throw new WorkspaceGitError('workspace_git_revert_unsupported')
  if (input.target.kind === 'hunks' && (file.status !== 'modified' || file.binary || file.rawBlob !== undefined))
    throw new WorkspaceGitError('workspace_git_revert_unsupported')
  const request: WorkspaceReadRequest = { kind: 'git_revert_preview', operationId: input.operationId,
    revision: snapshot.revision, file, target: input.target }
  const result = await requestWorkspaceRead(dependencies.database, dependencies.membership, actor, runId, repoId, request, signal)
  if (!result.ok) throw new CodingWorkspaceError(result.code)
  const preview = result as GitRevertPreviewInternal
  const fingerprint = gitDigest(JSON.stringify([runId, repoId, input.operationId, input.snapshotId, input.path,
    input.target.kind, input.target.kind === 'hunks' ? [...input.target.fingerprints].sort() : null]))
  await withReviewTransaction(dependencies.database, dependencies.membership, actor, runId, repoId, async client => {
    await insertPreview(client, { operationId: input.operationId, runId, repoId, ownerId: actor.userId, workspaceId: actor.workspaceId,
      kind: 'revert', requestFingerprint: fingerprint, previewVersion: preview.previewVersion, checkpointId: null,
      revision: snapshot.revision, files: [file], expected: preview.before,
      payload: { revision: snapshot.revision, file, target: input.target, expected: preview.before, after: preview.after,
        contentBase64: preview.afterContentBase64 ?? null },
      expiresAt: new Date(Date.now() + WORKSPACE_GIT_OPERATION_TTL_MS) })
  }, { historical: true, signal })
  return preview
}

async function finished(row: GitOperationRow) {
  const receipt = row.receipt
  if (!receipt || typeof receipt !== 'object') throw new WorkspaceGitError('workspace_git_operation_conflict')
  return { ...(receipt as GitRevertApplied), undoAvailable: row.undoAvailable }
}

/** The device re-derives HEAD and every content fence. A changed worktree or
 * HEAD returns 409 and the Agent/User bytes stay untouched. */
export async function applyRevert(dependencies: GitDependencies, actor: ReviewActor, runId: string, repoId: string,
  input: { operationId: string }, signal?: AbortSignal): Promise<GitRevertApplied> {
  const claimed = await withReviewTransaction(dependencies.database, dependencies.membership, actor, runId, repoId,
    async client => claimOperation(client, actor.userId, input.operationId), { historical: true, signal })
  if (claimed.kind === 'finished') {
    if (claimed.row.kind !== 'revert' || claimed.row.state !== 'applied')
      throw new WorkspaceGitError('workspace_git_operation_conflict')
    return finished(claimed.row)
  }
  const row = claimed.row
  const payload = row.payload as { revision: DiffRevision; file: GitRevertFile; target: GitRevertTarget
    expected: GitRevertPreviewInternal['before']; after: GitRevertPreviewInternal['after']; contentBase64: string | null } | null
  if (row.kind !== 'revert' || !payload || !row.previewVersion) {
    await releaseOperation(dependencies.database, actor.userId, input.operationId, false)
    throw new WorkspaceGitError('workspace_git_operation_conflict')
  }
  const request: WorkspaceReadRequest = { kind: 'git_revert_apply', operationId: input.operationId,
    previewVersion: row.previewVersion, revision: payload.revision as never, file: payload.file, target: payload.target,
    expected: payload.expected, after: payload.after, ...(payload.contentBase64 ? { contentBase64: payload.contentBase64 } : {}) }
  let applied: GitRevertApplied
  try {
    const result = await requestWorkspaceRead(dependencies.database, dependencies.membership, actor, runId, repoId, request, signal,
      { ttlMs: 60_000 })
    if (!result.ok) throw new CodingWorkspaceError(result.code)
    applied = result as GitRevertApplied
  } catch (error) {
    // Nothing was written: the preview stays reusable when the device was
    // merely unreachable, and is retired when the device refused.
    await releaseOperation(dependencies.database, actor.userId, input.operationId, retryable(error))
    throw error
  }
  // The device already wrote. If recording the result fails, the row stays
  // `delivering` so the stale reclaim can retry and observe the device's
  // idempotent "already applied" answer instead of forgetting the write.
  return withReviewTransaction(dependencies.database, dependencies.membership, actor, runId, repoId, async client => {
    const saved = await finishOperation(client, actor.userId, input.operationId, applied, new Date(Date.now() + WORKSPACE_GIT_UNDO_TTL_MS))
    await runChanged(client, runId)
    return { ...applied, undoAvailable: saved.undoAvailable }
  }, { historical: true, signal })
}

/** At most the most recent applied operation is undoable, for 24 hours, and
 * only while its masked capture still matches the current secret policy. */
export async function undoLastOperation(dependencies: GitDependencies, actor: ReviewActor, runId: string, repoId: string,
  input: { operationId: string; undoOf: string }, signal?: AbortSignal): Promise<GitUndone> {
  const claimed = await withReviewTransaction(dependencies.database, dependencies.membership, actor, runId, repoId, async client => {
    const candidate = await latestUndoable(client, actor.userId, runId, repoId, input.undoOf)
    if (!candidate) throw new WorkspaceGitError('workspace_git_undo_unavailable')
    if (candidate.state === 'undone') {
      const receipt = candidate.undoReceipt
      if (!receipt || typeof receipt !== 'object') throw new WorkspaceGitError('workspace_git_undo_unavailable')
      return { kind: 'finished' as const, receipt: receipt as GitUndone }
    }
    return claimUndo(client, actor.userId, input.undoOf)
  }, { historical: true, signal })
  if (claimed.kind === 'finished') return 'receipt' in claimed ? claimed.receipt : finishedUndo(claimed.row)
  const row = claimed.row
  try {
    const receipt = row.receipt as { headSha?: unknown } | null
    if (!row.undoFiles?.length || typeof receipt?.headSha !== 'string') throw new WorkspaceGitError('workspace_git_undo_unavailable')
    const mask = await secretMaskerFor({ workspaceId: actor.workspaceId, ownerId: actor.userId })
    const files = row.undoFiles.map(file => {
      const bytes = Buffer.from(file.base64, 'base64')
      const masked = maskCheckpoint({ patch: bytes, files: [] }, mask).patch
      if (!masked.equals(bytes)) throw new WorkspaceGitError('workspace_git_undo_unavailable')
      return { ...file, base64: masked.toString('base64'), sha256: gitDigest(masked) }
    })
    const request: WorkspaceReadRequest = { mode: 'files', kind: 'git_undo', operationId: input.operationId,
      undoOf: input.undoOf, expected: { headSha: receipt.headSha }, files: { files } }
    const result = await requestWorkspaceRead(dependencies.database, dependencies.membership, actor, runId, repoId, request, signal,
      { ttlMs: 60_000 })
    if (!result.ok) throw new CodingWorkspaceError(result.code)
    const undone = result as GitUndone
    return await withReviewTransaction(dependencies.database, dependencies.membership, actor, runId, repoId, async client => {
      await finishUndo(client, actor.userId, input.undoOf, undone)
      await runChanged(client, runId)
      return undone
    }, { historical: true, signal })
  } catch (error) {
    await releaseUndoClaim(dependencies.database, actor.userId, input.undoOf)
    throw error
  }
}

function finishedUndo(row: GitOperationRow): GitUndone {
  const receipt = row.undoReceipt
  if (!receipt || typeof receipt !== 'object') throw new WorkspaceGitError('workspace_git_undo_unavailable')
  return receipt as GitUndone
}
