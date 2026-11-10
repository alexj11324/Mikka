import 'server-only'
import { gunzipSync } from 'node:zlib'
import type { Pool } from 'pg'
import { CodingWorkspaceError, type WorkspaceReadRequest } from '@mikka/protocol/coding-workspace'
import {
  WORKSPACE_GIT_MAX_PATCH_BYTES, WORKSPACE_GIT_OPERATION_TTL_MS, WORKSPACE_GIT_UNDO_TTL_MS, WorkspaceGitError,
  type GitCheckpointRestorePreview, type GitCheckpointRestored, type GitStatus,
} from '@mikka/protocol/coding-workspace-git'
import { runChanged } from '../../live/panels'
import { requestWorkspaceRead } from '../requests'
import { resolveReviewScope, withReviewTransaction, type ReviewActor, type ReviewScope } from '../diff/authority'
import { gitDigest } from './evidence'
import { claimOperation, finishOperation, insertPreview, releaseOperation, type GitOperationRow } from './ops'
import { readCheckpointEntries } from './service'

export type GitDependencies = { database: Pool; membership: Pool }
const retryable = (error: unknown) => error instanceof CodingWorkspaceError
  && ['workspace_machine_unavailable', 'workspace_checkout_unavailable', 'workspace_request_expired'].includes(error.code)
const unavailable = () => new WorkspaceGitError('workspace_git_restore_unavailable')

/** Only the newest capture has a stored payload. The server inflates and
 * bounds it; the device proves the resulting files before writing. */
async function checkpointPayload(database: Pool, scope: ReviewScope, checkpointId: string) {
  const entry = (await readCheckpointEntries(database, scope)).find(candidate => candidate.checkpointId === checkpointId)
  if (!entry?.restorable) throw unavailable()
  const { rows: [legacy] } = await database.query<{ baseCommit: string; patch: Buffer | null; unavailableReason: 'too_large' | null }>(
    'SELECT "baseCommit",patch,"unavailableReason" FROM run_checkpoints WHERE "runId"=$1 AND "userId"=$2',
    [scope.identity.runId, scope.identity.ownerId])
  if (!legacy?.patch || legacy.unavailableReason || legacy.baseCommit !== entry.revision.baseSha) throw unavailable()
  let patch: Buffer
  try { patch = gunzipSync(legacy.patch, { maxOutputLength: WORKSPACE_GIT_MAX_PATCH_BYTES }) }
  catch { throw unavailable() }
  if (!patch.length || patch.length > WORKSPACE_GIT_MAX_PATCH_BYTES) throw unavailable()
  return { entry, patch, patchSha256: gitDigest(patch) }
}

async function observeLive(dependencies: GitDependencies, actor: ReviewActor, runId: string, repoId: string, signal?: AbortSignal) {
  const result = await requestWorkspaceRead(dependencies.database, dependencies.membership, actor, runId, repoId,
    { kind: 'git_status' }, signal)
  if (!result.ok) throw new CodingWorkspaceError(result.code)
  const status = result as GitStatus
  return { headSha: status.commitSha, workingTreeVersion: status.workingTreeVersion, identity: status.identity }
}

/** Dry run first: Git's 3-way merge happens in a throwaway worktree and the
 * person sees additions, deletions and conflicts before any real file moves. */
export async function previewCheckpointRestore(dependencies: GitDependencies, actor: ReviewActor, runId: string, repoId: string,
  input: { operationId: string; checkpointId: string }, signal?: AbortSignal): Promise<GitCheckpointRestorePreview> {
  const scope = await resolveReviewScope(dependencies.database, dependencies.membership, actor, runId, repoId)
  const { entry, patch, patchSha256 } = await checkpointPayload(dependencies.database, scope, input.checkpointId)
  const live = await observeLive(dependencies, actor, runId, repoId, signal)
  const request: WorkspaceReadRequest = { kind: 'git_checkpoint_preview', operationId: input.operationId,
    checkpointId: input.checkpointId, revision: entry.revision, patchBase64: patch.toString('base64'), patchSha256,
    expected: { headSha: live.headSha, workingTreeVersion: live.workingTreeVersion } }
  const result = await requestWorkspaceRead(dependencies.database, dependencies.membership, actor, runId, repoId, request, signal,
    { ttlMs: 60_000 })
  if (!result.ok) throw new CodingWorkspaceError(result.code)
  const preview = result as GitCheckpointRestorePreview
  const fingerprint = gitDigest(JSON.stringify([runId, repoId, input.operationId, input.checkpointId, entry.revision.version, patchSha256]))
  await withReviewTransaction(dependencies.database, dependencies.membership, actor, runId, repoId, async client => {
    await insertPreview(client, { operationId: input.operationId, runId, repoId, ownerId: actor.userId, workspaceId: actor.workspaceId,
      kind: 'restore', requestFingerprint: fingerprint, previewVersion: preview.previewVersion, checkpointId: input.checkpointId,
      revision: entry.revision, files: preview.files,
      expected: { headSha: live.headSha, workingTreeVersion: live.workingTreeVersion },
      payload: { patchSha256, revision: entry.revision, clean: preview.clean,
        expected: { headSha: live.headSha, workingTreeVersion: live.workingTreeVersion } },
      expiresAt: new Date(Date.now() + WORKSPACE_GIT_OPERATION_TTL_MS) })
  }, { historical: true, signal })
  return preview
}

async function finished(row: GitOperationRow): Promise<GitCheckpointRestored> {
  if (row.kind !== 'restore' || row.state !== 'applied') throw new WorkspaceGitError('workspace_git_operation_conflict')
  const receipt = row.receipt
  if (!receipt || typeof receipt !== 'object') throw new WorkspaceGitError('workspace_git_operation_conflict')
  return { ...(receipt as GitCheckpointRestored), undoAvailable: row.undoAvailable }
}

/** Conflicts are never applied: the plan and its conflict list are a refusal,
 * not permission to write markers into the Agent's worktree. */
export async function restoreCheckpoint(dependencies: GitDependencies, actor: ReviewActor, runId: string, repoId: string,
  input: { operationId: string }, signal?: AbortSignal): Promise<GitCheckpointRestored> {
  const claimed = await withReviewTransaction(dependencies.database, dependencies.membership, actor, runId, repoId,
    async client => claimOperation(client, actor.userId, input.operationId), { historical: true, signal })
  if (claimed.kind === 'finished') return finished(claimed.row)
  const row = claimed.row
  const payload = row.payload as { patchSha256: string; revision: { version: string }; clean: boolean
    expected: { headSha: string; workingTreeVersion: string } } | null
  if (row.kind !== 'restore' || !row.previewVersion || !row.checkpointId || !payload) {
    await releaseOperation(dependencies.database, actor.userId, input.operationId, false)
    throw new WorkspaceGitError('workspace_git_operation_conflict')
  }
  if (!payload.clean) {
    await releaseOperation(dependencies.database, actor.userId, input.operationId, false)
    throw new WorkspaceGitError('workspace_git_restore_conflict')
  }
  const scope = await resolveReviewScope(dependencies.database, dependencies.membership, actor, runId, repoId)
  const { entry, patch, patchSha256 } = await checkpointPayload(dependencies.database, scope, row.checkpointId)
  if (patchSha256 !== payload.patchSha256 || entry.revision.version !== payload.revision.version) {
    await releaseOperation(dependencies.database, actor.userId, input.operationId, false)
    throw unavailable()
  }
  const request: WorkspaceReadRequest = { kind: 'git_checkpoint_restore', operationId: input.operationId,
    checkpointId: row.checkpointId, revision: entry.revision, patchBase64: patch.toString('base64'), patchSha256,
    expected: payload.expected, previewVersion: row.previewVersion }
  let restored: GitCheckpointRestored
  try {
    const result = await requestWorkspaceRead(dependencies.database, dependencies.membership, actor, runId, repoId, request, signal,
      { ttlMs: 60_000 })
    if (!result.ok) throw new CodingWorkspaceError(result.code)
    restored = result as GitCheckpointRestored
  } catch (error) {
    await releaseOperation(dependencies.database, actor.userId, input.operationId, retryable(error))
    throw error
  }
  // The worktree has already been rewritten. A failure while recording it
  // leaves the row `delivering`: the stale reclaim re-observes the checkout,
  // and a device that can no longer match the confirmed fences refuses the
  // retry instead of writing twice.
  return withReviewTransaction(dependencies.database, dependencies.membership, actor, runId, repoId, async client => {
    const saved = await finishOperation(client, actor.userId, input.operationId, restored, new Date(Date.now() + WORKSPACE_GIT_UNDO_TTL_MS))
    await runChanged(client, runId)
    return { ...restored, undoAvailable: saved.undoAvailable }
  }, { historical: true, signal })
}
