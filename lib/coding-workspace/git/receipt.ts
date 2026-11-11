import { isDeepStrictEqual } from 'node:util'
import { CodingWorkspaceError, type WorkspaceReadReceipt, type WorkspaceReadRequest, type WorkspaceReadResult } from '@mikka/protocol/coding-workspace'
import {
  WORKSPACE_GIT_OPERATION_TTL_MS, gitCheckpointPreviewVersion, gitRevertPreviewVersion,
  gitCheckpointRestorePreview, gitCheckpointRestored, gitHistory, gitRevertApplied, gitRevertPreviewInternal, gitStatus, gitUndone,
  workspaceGitCheckpointPreviewResult, workspaceGitCheckpointRestoreResult, workspaceGitRevertApplyResult,
  workspaceGitRevertPreviewResult, workspaceGitUndoResult, type GitRevertAfter,
} from '@mikka/protocol/coding-workspace-git'
import type { DiffRevision } from '@mikka/protocol/coding-workspace-review'
import { maskDeep, type Masker } from '../../secrets/mask'
import { gitDigest, inversePatch, revertFileConsistent, revertedAfter, verifyRevertProofs } from './evidence'

export const isWorkspaceGitRequest = (request: WorkspaceReadRequest) => request.kind.startsWith('git_')
const denied = (code: 'workspace_version_conflict' | 'workspace_unsupported' | 'workspace_path_unavailable'): WorkspaceReadResult => ({ ok: false, code })
const sameRevision = (left: Pick<DiffRevision, 'source' | 'baseSha' | 'headSha' | 'treeSha' | 'version'>,
  right: Pick<DiffRevision, 'source' | 'baseSha' | 'headSha' | 'treeSha' | 'version'>) =>
  (['source', 'baseSha', 'headSha', 'treeSha', 'version'] as const).every(key => left[key] === right[key])
function masked(value: unknown, mask: Masker) { return isDeepStrictEqual(maskDeep(value, mask), value) }
function undoShape(receipt: WorkspaceReadReceipt, path: string) {
  const undo = receipt.gitUndo
  if (!undo) return null
  const file = undo.files[0]
  if (undo.files.length !== 1 || file?.path !== path) return null
  const bytes = Buffer.from(file.base64, 'base64')
  return bytes.toString('base64') === file.base64 && gitDigest(bytes) === file.sha256 ? { file, bytes } : null
}

/** A device receipt is a claim about the exact checkout. Only verified blob
 * proofs may become a public patch; write receipts must match the confirmed
 * preview byte-for-byte before the server records them. */
export function validateGitReceipt(request: WorkspaceReadRequest, receipt: WorkspaceReadReceipt, mask: Masker): WorkspaceReadResult | null {
  // A refusal is a real answer, not a malformed receipt. Parsing it as a
  // success DTO would erase the device's code and surface every honest
  // conflict (stale fence, unsupported mode, expired request) as "receipt
  // rejected". A refusal may not carry proofs or an Undo capture, though:
  // those only describe a write that happened.
  if (!receipt.result.ok) return receipt.blobs?.length || receipt.gitUndo ? null : receipt.result
  switch (request.kind) {
    case 'git_status': {
      const parsed = gitStatus.safeParse(receipt.result)
      if (!parsed.success) return null
      if (new Set(parsed.data.entries.map(entry => entry.path)).size !== parsed.data.entries.length) return null
      return masked(parsed.data, mask) ? parsed.data : denied('workspace_path_unavailable')
    }
    case 'git_history': {
      const parsed = gitHistory.safeParse(receipt.result)
      if (!parsed.success || parsed.data.commits.length > request.limit
        || new Set(parsed.data.commits.map(commit => commit.sha)).size !== parsed.data.commits.length) return null
      return masked(parsed.data, mask) ? parsed.data : denied('workspace_path_unavailable')
    }
    case 'git_revert_preview': {
      const parsed = workspaceGitRevertPreviewResult.safeParse(receipt.result)
      if (!parsed.success) return null
      const value = parsed.data
      if (value.operationId !== request.operationId || !sameRevision(value.revision, request.revision)
        || value.file.fileVersion !== request.file.fileVersion || !revertFileConsistent(value.file, request.file)
        || value.target.kind !== request.target.kind) return null
      if (request.target.kind === 'hunks' && (value.target.kind !== 'hunks'
        || !isDeepStrictEqual([...value.target.fingerprints].sort(), [...request.target.fingerprints].sort()))) return null
      if (request.target.kind === 'hunks' && (request.file.status !== 'modified' || request.file.binary)) return denied('workspace_unsupported')
      const verified = verifyRevertProofs(request.file, request.revision, receipt.blobs ?? [])
      if (!verified) return null
      if (value.before.exists !== (verified.before !== null)
        || value.before.contentSha256 !== (verified.before ? gitDigest(verified.before) : null)
        || value.before.mode !== (verified.before ? value.file.newMode : null)
        || value.before.size !== (verified.before ? verified.before.length : null)) return null
      let after: GitRevertAfter, patch: string | null, additions: number, deletions: number, revertedBytes: Buffer | null
      try {
        const reverted = revertedAfter(request.file, request.revision, request.target, verified.before, verified.base)
        after = reverted.after; revertedBytes = reverted.bytes
        const inverse = inversePatch({ file: request.file, before: verified.before, after: reverted.bytes, mask })
        patch = inverse.patch; additions = inverse.additions; deletions = inverse.deletions
      } catch (error) {
        if (error instanceof CodingWorkspaceError) return denied(error.code === 'workspace_unsupported' ? 'workspace_unsupported'
          : error.code === 'workspace_version_conflict' ? 'workspace_version_conflict' : 'workspace_path_unavailable')
        throw error
      }
      const previewVersion = gitRevertPreviewVersion({ operationId: request.operationId, revision: request.revision,
        file: request.file, target: request.target, before: value.before, after })
      const preview = gitRevertPreviewInternal.parse({ ok: true, kind: 'git_revert_preview', operationId: request.operationId,
        previewVersion, expiresAt: new Date(Date.now() + WORKSPACE_GIT_OPERATION_TTL_MS).toISOString(), observedAt: value.observedAt,
        revision: value.revision, file: value.file, target: value.target, before: value.before, after, patch, additions, deletions,
        undoAvailable: true, ...(revertedBytes ? { afterContentBase64: revertedBytes.toString('base64') } : {}) })
      return masked(preview, mask) ? preview : denied('workspace_path_unavailable')
    }
    case 'git_revert_apply': {
      const parsed = workspaceGitRevertApplyResult.safeParse(receipt.result)
      if (!parsed.success) return null
      const value = parsed.data
      if (value.operationId !== request.operationId || value.previewVersion !== request.previewVersion
        || value.headSha !== request.expected.headSha || value.after.path !== request.file.path
        || value.after.exists !== request.after.exists || value.after.contentSha256 !== request.after.contentSha256
        || value.after.mode !== request.after.mode) return null
      const undo = undoShape(receipt, request.file.path)
      if (receipt.gitUndo && (!undo || undo.file.existed !== request.expected.exists
        || (undo.file.existed ? undo.file.sha256 !== request.expected.contentSha256 : request.expected.contentSha256 !== null)
        || !isDeepStrictEqual(undo.file.after, { exists: value.after.exists, contentSha256: value.after.contentSha256 }))) return null
      const applied = gitRevertApplied.parse({ ok: true, kind: 'git_revert_applied', operationId: request.operationId,
        previewVersion: request.previewVersion, appliedAt: value.appliedAt, headSha: value.headSha,
        file: { path: request.file.path, action: value.after.exists ? 'restored' : 'deleted',
          contentSha256: value.after.contentSha256, workingVersion: value.after.workingVersion },
        index: 'untouched', idempotent: value.idempotent, undoAvailable: Boolean(undo) })
      return masked(applied, mask) ? applied : denied('workspace_path_unavailable')
    }
    case 'git_undo': {
      const parsed = workspaceGitUndoResult.safeParse(receipt.result)
      if (!parsed.success) return null
      const value = parsed.data
      if (value.operationId !== request.operationId || value.undoOf !== request.undoOf || value.headSha !== request.expected.headSha
        || value.files.length !== request.files.files.length) return null
      for (const [index, file] of value.files.entries()) {
        const expected = request.files.files[index]!
        if (file.path !== expected.path || file.action !== (expected.existed ? 'restored' : 'deleted')
          || file.contentSha256 !== (expected.existed ? expected.sha256 : null)) return null
      }
      const undone = gitUndone.parse({ ok: true, kind: 'git_undone', operationId: value.operationId, undoOf: value.undoOf,
        appliedAt: value.appliedAt, headSha: value.headSha, files: value.files })
      return masked(undone, mask) ? undone : denied('workspace_path_unavailable')
    }
    case 'git_checkpoint_preview': {
      const parsed = workspaceGitCheckpointPreviewResult.safeParse(receipt.result)
      if (!parsed.success) return null
      const value = parsed.data
      if (value.operationId !== request.operationId || !sameRevision(value.revision, request.revision)
        || value.headSha !== request.expected.headSha || value.workingTreeVersion !== request.expected.workingTreeVersion) return null
      if (gitCheckpointPreviewVersion({ operationId: request.operationId, checkpointId: request.checkpointId,
        revision: request.revision, patchSha256: request.patchSha256, headSha: value.headSha,
        workingTreeVersion: value.workingTreeVersion, files: value.files, conflicts: value.conflicts }) !== value.previewVersion) return null
      if (new Set(value.files.map(file => file.path)).size !== value.files.length) return null
      const preview = gitCheckpointRestorePreview.parse({ ok: true, kind: 'git_checkpoint_restore_preview',
        operationId: request.operationId, previewVersion: value.previewVersion,
        expiresAt: new Date(Date.now() + WORKSPACE_GIT_OPERATION_TTL_MS).toISOString(), checkpointId: request.checkpointId,
        revision: value.revision, observedAt: value.observedAt, clean: value.clean, files: value.files, conflicts: value.conflicts,
        undoAvailable: true })
      return masked(preview, mask) ? preview : denied('workspace_path_unavailable')
    }
    case 'git_checkpoint_restore': {
      const parsed = workspaceGitCheckpointRestoreResult.safeParse(receipt.result)
      if (!parsed.success) return null
      const value = parsed.data
      if (value.operationId !== request.operationId || value.previewVersion !== request.previewVersion
        || value.checkpointId !== request.checkpointId || value.headSha !== request.expected.headSha) return null
      const undo = receipt.gitUndo
      if (undo) {
        for (const file of undo.files) {
          const bytes = Buffer.from(file.base64, 'base64')
          if (bytes.toString('base64') !== file.base64 || gitDigest(bytes) !== file.sha256) return null
        }
      }
      const restored = gitCheckpointRestored.parse({ ok: true, kind: 'git_checkpoint_restored', operationId: request.operationId,
        previewVersion: request.previewVersion, appliedAt: value.appliedAt, headSha: value.headSha,
        workingTreeVersion: value.workingTreeVersion, checkpointId: request.checkpointId, files: value.files,
        idempotent: value.idempotent, undoAvailable: Boolean(undo) })
      return masked(restored, mask) ? restored : denied('workspace_path_unavailable')
    }
    default: return null
  }
}
