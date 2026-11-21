import { createHash } from 'node:crypto'
import { z } from 'zod'
import { runWorktreeIdentity, workspacePath, visibleWorkspacePath, workingSourceRevision } from './coding-workspace-common'
import { diffFileMetadata, diffRevision, runRepositoryIdentity } from './coding-workspace-review'

/** Git status, history, file/hunk revert and checkpoint restore for the exact
 * Run checkout authorized by #1743. This module deliberately reuses
 * RunWorktreeIdentity, DiffRevision, DiffFileMetadata and sourceRevision: a
 * second Git fact source would let the UI show one tree and write another. */
export const WORKSPACE_GIT_REQUEST_HEADER = 'x-mikka-coding-workspace-git'
export const WORKSPACE_GIT_MAX_COMMITS = 50
export const WORKSPACE_GIT_MAX_STATUS_ENTRIES = 5_000
export const WORKSPACE_GIT_MAX_UNDO_FILES = 100
export const WORKSPACE_GIT_MAX_UNDO_BYTES = 1024 * 1024
export const WORKSPACE_GIT_MAX_PATCH_BYTES = 2 * 1024 * 1024
export const WORKSPACE_GIT_OPERATION_TTL_MS = 5 * 60_000
export const WORKSPACE_GIT_UNDO_TTL_MS = 24 * 60 * 60_000
export const WORKSPACE_GIT_REQUEST_TTL_MS = 60_000

const sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const path = workspacePath.refine(value => Boolean(value) && visibleWorkspacePath(value))
const fileMode = z.enum(['100644', '100755'])
const anyMode = z.enum(['100644', '100755', '120000', '160000'])
const encoded = (bytes: number) => z.string().max(Math.ceil(bytes / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)

export const gitChangeState = z.enum(['added', 'modified', 'deleted', 'renamed', 'copied', 'type_changed', 'untracked', 'conflicted'])
export type GitChangeState = z.infer<typeof gitChangeState>

/** A descriptor-checked observation of one worktree file. `workingVersion` is
 * a stat fence (device/inode/mtime/ctime/size/mode) or the literal "missing";
 * it is never derived from user input. `contentSha256` hashes the raw bytes,
 * including BOM and CRLF, and is null when the file is absent or unreadable. */
export const gitWorkingFence = z.strictObject({
  headSha: sha, path, exists: z.boolean(), mode: anyMode.nullable(),
  size: z.number().int().nonnegative().nullable(), contentSha256: digest.nullable(), workingVersion: digest,
})
export type GitWorkingFence = z.infer<typeof gitWorkingFence>

export const gitStatusEntry = z.strictObject({
  path, previousPath: path.nullable(),
  index: gitChangeState.nullable(), worktree: gitChangeState.nullable(),
  conflicted: z.boolean(), untracked: z.boolean(),
  mode: anyMode.nullable(), size: z.number().int().nonnegative().nullable(),
  contentSha256: digest.nullable(), workingVersion: digest,
  /** null means the bounded observation could not decide (large/unsafe). */
  binary: z.boolean().nullable(), lfs: z.boolean(),
})
export type GitStatusEntry = z.infer<typeof gitStatusEntry>

export const gitUpstream = z.strictObject({
  remote: z.string().min(1).max(255), branch: z.string().min(1).max(255),
  ahead: z.number().int().nonnegative().max(1_000_000_000), behind: z.number().int().nonnegative().max(1_000_000_000),
})
export const gitBranchState = z.strictObject({
  headSha: sha, baseSha: sha.nullable(), branch: z.string().min(1).max(255).nullable(), detached: z.boolean(),
  upstream: gitUpstream.nullable(),
})
export type GitBranchState = z.infer<typeof gitBranchState>

export const gitCommit = z.strictObject({
  sha, parents: z.array(sha).max(8),
  authorName: z.string().max(200), authorEmail: z.string().max(320),
  authoredAt: z.iso.datetime(), committedAt: z.iso.datetime(), subject: z.string().max(1000),
  head: z.boolean(), base: z.boolean(),
})
export type GitCommit = z.infer<typeof gitCommit>

const onlineObservation = { ok: z.literal(true), identity: runWorktreeIdentity, observedAt: z.iso.datetime(), availability: z.literal('online') }
/** `revision.version` is the working tree fence for this observation. It is
 * intentionally distinct from a Diff manifest `sourceVersion`; pass a Diff
 * snapshot's own revision to revert/diff calls instead of this value. */
export const gitStatus = z.strictObject({
  ...onlineObservation, kind: z.literal('git_status'),
  revision: workingSourceRevision, commitSha: sha, workingTreeVersion: digest,
  branch: gitBranchState, entries: z.array(gitStatusEntry).max(WORKSPACE_GIT_MAX_STATUS_ENTRIES), truncated: z.boolean(),
}).refine(value => value.commitSha === value.revision.headSha && value.workingTreeVersion === value.revision.version
  && value.branch.headSha === value.commitSha && value.entries.every(entry => !entry.untracked || entry.index === null))
export type GitStatus = z.infer<typeof gitStatus>

export const gitHistory = z.strictObject({
  ...onlineObservation, kind: z.literal('git_history'),
  revision: workingSourceRevision, commitSha: sha, workingTreeVersion: digest,
  branch: gitBranchState, commits: z.array(gitCommit).max(WORKSPACE_GIT_MAX_COMMITS + 1), nextCursor: z.string().max(256).nullable(),
}).refine(value => value.commitSha === value.revision.headSha && value.workingTreeVersion === value.revision.version
  && value.branch.headSha === value.commitSha && value.commits.every((commit, index) => index === 0 || commit.head === false))
export type GitHistory = z.infer<typeof gitHistory>

export const gitFrozenReason = z.enum(['machine_unavailable', 'checkout_unavailable', 'no_live_checkout'])
/** A stopped Run is never relabelled as a live worktree. The timeline is a
 * projection of retained commit snapshots and the Run publication, not a
 * second Git reader and not fabricated working-tree state. */
export const gitFrozen = z.strictObject({
  ok: z.literal(true), identity: runRepositoryIdentity, kind: z.enum(['git_status', 'git_history']),
  observedAt: z.iso.datetime(), availability: z.literal('offline'), frozen: z.literal(true),
  reason: gitFrozenReason, source: z.enum(['checkpoint', 'commit', 'pull_request']),
  branch: z.string().min(1).max(255).nullable(), commitSha: sha.nullable(), baseSha: sha.nullable(),
  pullRequest: z.strictObject({ number: z.number().int().positive(), url: z.url(), headSha: sha, baseSha: sha.optional(),
    state: z.enum(['open', 'closed', 'merged']) }).nullable(),
  commits: z.array(gitCommit).max(WORKSPACE_GIT_MAX_COMMITS),
})
export type GitFrozen = z.infer<typeof gitFrozen>

export const workspaceGitReadRequest = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('git_status') }),
  z.strictObject({ kind: z.literal('git_history'), cursor: z.string().max(256).optional(),
    limit: z.number().int().min(1).max(WORKSPACE_GIT_MAX_COMMITS).default(30) }),
])
export type WorkspaceGitReadRequest = z.infer<typeof workspaceGitReadRequest>
export const workspaceGitReadResult = z.union([gitStatus, gitHistory])
export type WorkspaceGitReadResult = z.infer<typeof workspaceGitReadResult>

/** A revert is always bound to one immutable local diff snapshot: the client
 * selects what it saw, never a caller-supplied patch or Base/HEAD pair. */
export const gitRevertTarget = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('file') }),
  z.strictObject({ kind: z.literal('hunks'), fingerprints: z.array(digest).min(1).max(200) }),
])
export type GitRevertTarget = z.infer<typeof gitRevertTarget>
export const gitRevertFile = z.strictObject({
  path, previousPath: z.null(), status: z.enum(['added', 'deleted', 'modified']),
  oldBlob: sha.nullable(), newBlob: sha.nullable(), oldMode: fileMode.nullable(), newMode: fileMode.nullable(),
  oldSize: z.number().int().nonnegative().nullable(), newSize: z.number().int().nonnegative().nullable(),
  binary: z.boolean(), fileVersion: digest,
  /** Present only when a built-in clean conversion produced the snapshot. */
  rawBlob: sha.optional(), rawSize: z.number().int().nonnegative().optional(),
}).refine(value => Boolean(value.rawBlob) === Boolean(value.rawSize !== undefined))
export type GitRevertFile = z.infer<typeof gitRevertFile>
const workingRevision = diffRevision.refine(value => value.source === 'working' && value.baseSha !== null
  && value.headSha !== null && value.treeSha === null)

export const workspaceGitRevertPreviewRequest = z.strictObject({
  kind: z.literal('git_revert_preview'), operationId: z.uuid(),
  revision: workingRevision, file: gitRevertFile, target: gitRevertTarget,
})
export type WorkspaceGitRevertPreviewRequest = z.infer<typeof workspaceGitRevertPreviewRequest>
/** Device facts only: complete before/base bytes travel as receipt blobs and
 * the server builds the inverse patch from verified content. */
export const workspaceGitRevertPreviewResult = z.strictObject({
  ...onlineObservation, kind: z.literal('git_revert_preview'), operationId: z.uuid(),
  revision: diffRevision, file: diffFileMetadata, target: gitRevertTarget,
  before: gitWorkingFence,
}).refine(value => value.before.headSha === value.revision.headSha && value.before.path === value.file.path)
export type WorkspaceGitRevertPreviewResult = z.infer<typeof workspaceGitRevertPreviewResult>

export const gitRevertAfter = z.strictObject({
  exists: z.boolean(), mode: fileMode.nullable(), contentSha256: digest.nullable(),
}).refine(value => value.exists === (value.contentSha256 !== null && value.mode !== null))
export type GitRevertAfter = z.infer<typeof gitRevertAfter>

export const gitRevertPreview = z.strictObject({
  ok: z.literal(true), kind: z.literal('git_revert_preview'), operationId: z.uuid(), previewVersion: digest,
  expiresAt: z.iso.datetime(), observedAt: z.iso.datetime(),
  revision: diffRevision, file: diffFileMetadata, target: gitRevertTarget,
  before: gitWorkingFence, after: gitRevertAfter,
  patch: z.string().max(WORKSPACE_GIT_MAX_PATCH_BYTES).nullable(), additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(), undoAvailable: z.boolean(),
})
export type GitRevertPreview = z.infer<typeof gitRevertPreview>
/** Server-internal: the exact post-revert bytes are retained in the ephemeral
 * request/operation row so Apply can send them back for a byte-for-byte CAS.
 * The HTTP layer strips this field; it is never part of the client contract. */
export const gitRevertPreviewInternal = gitRevertPreview.extend({ afterContentBase64: encoded(1024 * 1024).optional() })
export type GitRevertPreviewInternal = z.infer<typeof gitRevertPreviewInternal>

export const workspaceGitRevertApplyRequest = z.strictObject({
  kind: z.literal('git_revert_apply'), operationId: z.uuid(), previewVersion: digest,
  revision: workingRevision, file: gitRevertFile, target: gitRevertTarget,
  expected: gitWorkingFence, after: gitRevertAfter,
  /** The exact result content, already verified against a base blob proof.
   * Absent exactly when the result is a deletion. */
  contentBase64: encoded(1024 * 1024).optional(),
}).refine(value => value.after.exists === Boolean(value.contentBase64))
export type WorkspaceGitRevertApplyRequest = z.infer<typeof workspaceGitRevertApplyRequest>

export const workspaceGitRevertApplyResult = z.strictObject({
  ...onlineObservation, kind: z.literal('git_revert_applied'), operationId: z.uuid(), previewVersion: digest,
  appliedAt: z.iso.datetime(), headSha: sha, after: gitWorkingFence, idempotent: z.boolean(),
}).refine(value => value.after.headSha === value.headSha)
export type WorkspaceGitRevertApplyResult = z.infer<typeof workspaceGitRevertApplyResult>
/** Reverts are working-tree only: no index, ref, checkout or remote mutation. */
export const gitRevertApplied = z.strictObject({
  ok: z.literal(true), kind: z.literal('git_revert_applied'), operationId: z.uuid(), previewVersion: digest,
  appliedAt: z.iso.datetime(), headSha: sha, file: z.strictObject({ path, action: z.enum(['restored', 'deleted']),
    contentSha256: digest.nullable(), workingVersion: digest }), index: z.literal('untouched'), idempotent: z.boolean(),
  undoAvailable: z.boolean(),
})
export type GitRevertApplied = z.infer<typeof gitRevertApplied>

/** One masked pre-operation capture. The server never stores, returns or logs
 * the unmasked bytes; masking is checked before the receipt may be retained. */
export const gitUndoFile = z.strictObject({
  path, existed: z.boolean(), mode: anyMode.nullable(), base64: encoded(WORKSPACE_GIT_MAX_UNDO_BYTES), sha256: digest,
  /** The state the daemon must observe before restoring this file. */
  after: z.strictObject({ exists: z.boolean(), contentSha256: digest.nullable() }),
})
export type GitUndoFile = z.infer<typeof gitUndoFile>
export const workspaceGitUndoProof = z.strictObject({
  files: z.array(gitUndoFile).min(1).max(WORKSPACE_GIT_MAX_UNDO_FILES),
}).refine(value => value.files.reduce((bytes, file) => bytes + file.base64.length / 4 * 3 -
  (file.base64.endsWith('==') ? 2 : file.base64.endsWith('=') ? 1 : 0), 0) <= WORKSPACE_GIT_MAX_UNDO_BYTES)

export const workspaceGitUndoRequest = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('files'), kind: z.literal('git_undo'), operationId: z.uuid(), undoOf: z.uuid(),
    expected: z.strictObject({ headSha: sha }), files: workspaceGitUndoProof }),
])
export type WorkspaceGitUndoRequest = z.infer<typeof workspaceGitUndoRequest>
const gitUndoResultShape = z.strictObject({
  ...onlineObservation, kind: z.literal('git_undone'), operationId: z.uuid(), undoOf: z.uuid(),
  appliedAt: z.iso.datetime(), headSha: sha, files: z.array(z.strictObject({ path, action: z.enum(['restored', 'deleted']),
    contentSha256: digest.nullable() })).max(WORKSPACE_GIT_MAX_UNDO_FILES),
})
export const workspaceGitUndoResult = gitUndoResultShape
  .refine(value => value.files.every(file => (file.action === 'restored') === (file.contentSha256 !== null)))
export type WorkspaceGitUndoResult = z.infer<typeof workspaceGitUndoResult>
export const gitUndone = gitUndoResultShape.omit({ identity: true, observedAt: true, availability: true }).extend({ ok: z.literal(true) })
export type GitUndone = z.infer<typeof gitUndone>

export const gitCheckpointRevision = diffRevision.extend({
  source: z.literal('checkpoint'), baseSha: sha, headSha: sha.nullable(), treeSha: sha.nullable(),
})
export type GitCheckpointRevision = z.infer<typeof gitCheckpointRevision>
export const gitCheckpointEntry = z.strictObject({
  checkpointId: z.string().min(1).max(80), revision: gitCheckpointRevision, takenAt: z.iso.datetime(),
  files: z.number().int().nonnegative(), restorable: z.boolean(),
  reason: z.enum(['missing_evidence', 'too_large', 'unsupported', 'version_changed', 'missing_payload']).nullable(),
})
export const gitCheckpointList = z.strictObject({
  ok: z.literal(true), identity: runRepositoryIdentity, checkpoints: z.array(gitCheckpointEntry).max(50),
})
export type GitCheckpointList = z.infer<typeof gitCheckpointList>

export const gitRestoreAction = z.strictObject({
  path, previousPath: path.nullable(), action: z.enum(['added', 'modified', 'deleted', 'renamed']),
  beforeSha256: digest.nullable(), afterSha256: digest.nullable(), conflicts: z.boolean(),
}).refine(value => (value.action === 'deleted') === (value.afterSha256 === null))
  .refine(value => (value.action === 'renamed') === (value.previousPath !== null))
export const gitRestoreConflict = z.strictObject({ path, reason: z.enum(['content', 'delete_modify', 'rename', 'mode', 'submodule', 'binary', 'unavailable']) })

const checkpointRequest = { kind: z.literal('git_checkpoint_preview'), operationId: z.uuid(), checkpointId: z.string().min(1).max(80),
  revision: gitCheckpointRevision, patchBase64: encoded(WORKSPACE_GIT_MAX_PATCH_BYTES), patchSha256: digest,
  expected: z.strictObject({ headSha: sha, workingTreeVersion: digest }) }
export const workspaceGitCheckpointPreviewRequest = z.strictObject(checkpointRequest)
export type WorkspaceGitCheckpointPreviewRequest = z.infer<typeof workspaceGitCheckpointPreviewRequest>
export const workspaceGitCheckpointRestoreRequest = z.strictObject({ ...checkpointRequest, kind: z.literal('git_checkpoint_restore'),
  previewVersion: digest })
export type WorkspaceGitCheckpointRestoreRequest = z.infer<typeof workspaceGitCheckpointRestoreRequest>

export const workspaceGitCheckpointPreviewResult = z.strictObject({
  ...onlineObservation, kind: z.literal('git_checkpoint_preview'), operationId: z.uuid(),
  revision: gitCheckpointRevision, headSha: sha, workingTreeVersion: digest, previewVersion: digest,
  clean: z.boolean(), files: z.array(gitRestoreAction).max(WORKSPACE_GIT_MAX_STATUS_ENTRIES),
  conflicts: z.array(gitRestoreConflict).max(WORKSPACE_GIT_MAX_STATUS_ENTRIES),
}).refine(value => value.clean === (value.conflicts.length === 0 && value.files.every(file => !file.conflicts)))
export type WorkspaceGitCheckpointPreviewResult = z.infer<typeof workspaceGitCheckpointPreviewResult>

export const gitCheckpointRestorePreview = z.strictObject({
  ok: z.literal(true), kind: z.literal('git_checkpoint_restore_preview'), operationId: z.uuid(), previewVersion: digest,
  expiresAt: z.iso.datetime(), checkpointId: z.string().min(1).max(80), revision: gitCheckpointRevision,
  observedAt: z.iso.datetime(), clean: z.boolean(),
  files: z.array(gitRestoreAction).max(WORKSPACE_GIT_MAX_STATUS_ENTRIES),
  conflicts: z.array(gitRestoreConflict).max(WORKSPACE_GIT_MAX_STATUS_ENTRIES), undoAvailable: z.boolean(),
})
export type GitCheckpointRestorePreview = z.infer<typeof gitCheckpointRestorePreview>

export const workspaceGitCheckpointRestoreResult = z.strictObject({
  ...onlineObservation, kind: z.literal('git_checkpoint_restored'), operationId: z.uuid(), previewVersion: digest,
  appliedAt: z.iso.datetime(), headSha: sha, workingTreeVersion: digest, checkpointId: z.string().min(1).max(80),
  files: z.array(gitRestoreAction).max(WORKSPACE_GIT_MAX_STATUS_ENTRIES), idempotent: z.boolean(),
})
export type WorkspaceGitCheckpointRestoreResult = z.infer<typeof workspaceGitCheckpointRestoreResult>
export const gitCheckpointRestored = z.strictObject({
  ok: z.literal(true), kind: z.literal('git_checkpoint_restored'), operationId: z.uuid(), previewVersion: digest,
  appliedAt: z.iso.datetime(), headSha: sha, workingTreeVersion: digest, checkpointId: z.string().min(1).max(80),
  files: z.array(gitRestoreAction).max(WORKSPACE_GIT_MAX_STATUS_ENTRIES), idempotent: z.boolean(), undoAvailable: z.boolean(),
})
export type GitCheckpointRestored = z.infer<typeof gitCheckpointRestored>

/** The device and the server compute this exact value before a write. It
 * commits to the preview the person confirmed: operation, revision, file
 * identity, selected hunks, before fence and resulting content. */
export function gitRevertPreviewVersion(input: {
  operationId: string; revision: { version: string }; file: { fileVersion: string }; target: GitRevertTarget
  before: Pick<GitWorkingFence, 'workingVersion' | 'contentSha256' | 'exists' | 'mode'>
  after: GitRevertAfter
}) {
  const { operationId, revision, file, target, before, after } = input
  return gitDigest(JSON.stringify([operationId, revision.version, file.fileVersion,
    target.kind, target.kind === 'hunks' ? [...target.fingerprints].sort() : null,
    before.workingVersion, before.contentSha256, before.exists, before.mode,
    after.exists, after.contentSha256, after.mode]))
}
function gitDigest(value: string) { return createHash('sha256').update(value).digest('hex') }
export function gitCheckpointPreviewVersion(input: {
  operationId: string; checkpointId: string; revision: { version: string }; patchSha256: string
  headSha: string; workingTreeVersion: string
  files: { path: string; action: string; beforeSha256: string | null; afterSha256: string | null; conflicts: boolean }[]
  conflicts: { path: string; reason: string }[]
}) {
  return gitDigest(JSON.stringify([input.operationId, input.checkpointId, input.revision.version, input.patchSha256,
    input.headSha, input.workingTreeVersion,
    input.files.map(file => [file.path, file.action, file.beforeSha256, file.afterSha256, file.conflicts]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    input.conflicts.map(conflict => [conflict.path, conflict.reason]).sort((a, b) => a[0]!.localeCompare(b[0]!))]))
}

export const WORKSPACE_GIT_ERROR_CODES = [
  'workspace_git_revert_conflict', 'workspace_git_revert_unsupported',
  'workspace_git_restore_conflict', 'workspace_git_restore_unavailable',
  'workspace_git_undo_unavailable', 'workspace_git_operation_conflict', 'workspace_git_operation_expired',
] as const
export type WorkspaceGitErrorCode = typeof WORKSPACE_GIT_ERROR_CODES[number]
export class WorkspaceGitError extends Error {
  constructor(readonly code: WorkspaceGitErrorCode, options?: ErrorOptions) { super(code, options); this.name = 'WorkspaceGitError' }
}
