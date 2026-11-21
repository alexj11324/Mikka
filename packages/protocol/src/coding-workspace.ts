import { z } from 'zod'
import { WORKSPACE_MAX_FILE_BYTES, WORKSPACE_MAX_RESPONSE_BYTES, visibleWorkspacePath, workspacePath, runWorktreeIdentity, sourceRevision, type RunWorktreeIdentity } from './coding-workspace-common'
import { workspaceDiffReadRequest, workspaceDiffReadResult, workspaceDiffBlobProof } from './coding-workspace-review'
import {
  gitCheckpointRestorePreview, gitCheckpointRestored, gitRevertApplied, gitRevertPreviewInternal, gitUndone,
  workspaceGitCheckpointPreviewRequest, workspaceGitCheckpointRestoreRequest, workspaceGitCheckpointRestoreResult,
  workspaceGitCheckpointPreviewResult, workspaceGitReadRequest, workspaceGitReadResult, workspaceGitRevertApplyRequest,
  workspaceGitRevertApplyResult, workspaceGitRevertPreviewRequest, workspaceGitRevertPreviewResult, workspaceGitUndoProof,
  workspaceGitUndoRequest, workspaceGitUndoResult,
} from './coding-workspace-git'
export * from './coding-workspace-common'
const sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)

export const fileRange = z.strictObject({ startLine: z.number().int().min(1).max(1_000_000), endLine: z.number().int().min(1).max(1_000_000) })
  .refine(value => value.endLine >= value.startLine && value.endLine - value.startLine < 2000)
const expected = z.strictObject({ headSha: sha, contentSha256: digest })
export const workspaceFileSelection = z.strictObject({ path: workspacePath.refine(Boolean), range: fileRange.optional(), expected: expected.optional() })
export type WorkspaceFileSelection = z.infer<typeof workspaceFileSelection>
export const workspaceContextSelection = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('file'), path: workspacePath.refine(Boolean), range: fileRange.optional() }),
  z.strictObject({ kind: z.literal('folder'), path: workspacePath }),
  z.strictObject({ kind: z.literal('resolved'), files: z.array(workspaceFileSelection).min(1).max(20) }),
])

export const workspaceFileReadRequest = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('tree'), path: workspacePath.default(''), cursor: z.string().max(256).optional(), limit: z.number().int().min(1).max(200).default(100) }),
  z.strictObject({ kind: z.literal('file'), path: workspacePath.refine(Boolean), range: fileRange.optional(), expected: expected.optional() }),
  z.strictObject({ kind: z.literal('search'), query: z.string().min(1).max(200), limit: z.number().int().min(1).max(100).default(30) }),
  z.strictObject({ kind: z.literal('context'), selection: workspaceContextSelection }),
])
export const workspaceReadRequest = z.union([workspaceFileReadRequest, workspaceDiffReadRequest, workspaceGitReadRequest,
  workspaceGitRevertPreviewRequest, workspaceGitRevertApplyRequest, workspaceGitUndoRequest,
  workspaceGitCheckpointPreviewRequest, workspaceGitCheckpointRestoreRequest])
export type WorkspaceReadRequest = z.infer<typeof workspaceReadRequest>

export function workspaceRequestPathsAllowed(request: WorkspaceReadRequest): boolean {
  if (request.kind === 'diff_snapshot' || request.kind === 'git_status' || request.kind === 'git_history' || request.kind === 'git_checkpoint_preview') return true
  if (request.kind === 'diff_file') return visibleWorkspacePath(request.file.path) &&
    (request.file.previousPath === null || visibleWorkspacePath(request.file.previousPath))
  if (request.kind === 'git_revert_preview' || request.kind === 'git_revert_apply') return visibleWorkspacePath(request.file.path)
  if (request.kind === 'git_undo') return request.files.files.every(file => visibleWorkspacePath(file.path))
  if (request.kind === 'git_checkpoint_restore') return true
  if (request.kind === 'search') return true
  if (request.kind !== 'context') return visibleWorkspacePath(request.path)
  return request.selection.kind === 'resolved' ? request.selection.files.every(file => visibleWorkspacePath(file.path))
    : visibleWorkspacePath(request.selection.path)
}

export const WORKSPACE_ERROR_CODES = [
  'workspace_not_found', 'workspace_machine_unavailable', 'workspace_checkout_unavailable',
  'workspace_path_unavailable', 'workspace_version_conflict', 'workspace_limit_exceeded',
  'workspace_request_expired', 'workspace_unsupported', 'workspace_invalid_request',
] as const
export type WorkspaceErrorCode = typeof WORKSPACE_ERROR_CODES[number]
export const workspaceFailure = z.strictObject({ ok: z.literal(false), code: z.enum(WORKSPACE_ERROR_CODES) })
export type WorkspaceFailure = z.infer<typeof workspaceFailure>

export const workspaceEntry = z.strictObject({
  path: workspacePath, name: z.string().min(1).max(255), kind: z.enum(['directory', 'file']),
  size: z.number().int().nonnegative().nullable(),
})
export type WorkspaceEntry = z.infer<typeof workspaceEntry>
const observation = {
  // Keep the v1 wire schema compatible. matchesWorkspaceResponse separately
  // rejects a non-working receipt; checkpoint HEAD nullability is Diff-only.
  ok: z.literal(true), identity: runWorktreeIdentity, revision: sourceRevision.extend({ headSha: sha }),
  observedAt: z.iso.datetime(), availability: z.literal('online'),
}
export const workspaceFileResult = z.strictObject({ ...observation, kind: z.literal('file'), path: workspacePath, size: z.number().int().nonnegative(),
    format: z.enum(['text', 'binary', 'too_large', 'unsupported']), content: z.string().max(WORKSPACE_MAX_RESPONSE_BYTES).nullable(),
    contentSha256: digest.nullable(), language: z.string().max(40).nullable(),
    startLine: z.number().int().positive(), endLine: z.number().int().nonnegative(), totalLines: z.number().int().nonnegative().nullable(),
    truncated: z.boolean(), editable: z.literal(false),
  })
export const workspaceReadResult = z.union([
  workspaceFailure,
  workspaceDiffReadResult,
  workspaceGitReadResult,
  workspaceGitRevertPreviewResult,
  workspaceGitRevertApplyResult,
  workspaceGitUndoResult,
  workspaceGitCheckpointPreviewResult,
  workspaceGitCheckpointRestoreResult,
  gitRevertPreviewInternal, gitRevertApplied, gitUndone, gitCheckpointRestorePreview, gitCheckpointRestored,
  workspaceFileResult,
  z.strictObject({ ...observation, kind: z.literal('tree'), path: workspacePath, entries: z.array(workspaceEntry).max(200), nextCursor: z.string().max(256).nullable(), truncated: z.boolean() }),
  z.strictObject({ ...observation, kind: z.literal('search'), entries: z.array(workspaceEntry).max(100), truncated: z.boolean() }),
  z.strictObject({ ...observation, kind: z.literal('context'), files: z.array(workspaceFileResult).min(1).max(20), omitted: z.number().int().nonnegative() }),
])
export type WorkspaceReadResult = z.infer<typeof workspaceReadResult>
export type WorkspaceFileResult = Extract<WorkspaceReadResult, { kind: 'file' }>

/** Private device-to-server validation envelope. Whole file bytes are checked
 * for secrets before any selected range may leave the server. They must never
 * be stored in a request result, a mention or a public API response. */
const validationFile = z.strictObject({
  path: workspacePath.refine(Boolean),
  base64: z.string().max(Math.ceil(WORKSPACE_MAX_FILE_BYTES / 3) * 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
})
export const workspaceReadReceipt = z.strictObject({
  result: workspaceReadResult,
  files: z.array(validationFile).max(20),
  blobs: z.array(workspaceDiffBlobProof).max(2).optional(),
  /** Write receipts only: the pre-operation source captured for Undo. It is
   * masked and consumed by the server before `result` is stored or returned. */
  gitUndo: workspaceGitUndoProof.optional(),
}).refine(value => value.files.reduce((bytes, file) => bytes + file.base64.length / 4 * 3 -
  (file.base64.endsWith('==') ? 2 : file.base64.endsWith('=') ? 1 : 0), 0) <= WORKSPACE_MAX_FILE_BYTES)
export type WorkspaceReadReceipt = z.infer<typeof workspaceReadReceipt>

function sameRunWorktreeIdentity(left: RunWorktreeIdentity, right: RunWorktreeIdentity) {
  return Object.keys(right).every(key => left[key as keyof RunWorktreeIdentity] === right[key as keyof RunWorktreeIdentity])
}
type RevisionLike = { source?: unknown; baseSha?: unknown; headSha?: unknown; treeSha?: unknown; version?: unknown }
function sameGitRevision(left: RevisionLike, right: RevisionLike) {
  return ['source', 'baseSha', 'headSha', 'treeSha', 'version'].every(key => left[key as keyof RevisionLike] === right[key as keyof RevisionLike])
}

/** Match a device receipt to the exact authorized request. Nested files must
 * carry the same binding and observation, never a second run/repository. */
export function matchesWorkspaceResponse(request: WorkspaceReadRequest, identity: RunWorktreeIdentity, result: WorkspaceReadResult): boolean {
  if (!result.ok) return true
  // Public wire DTOs never carry identity; a device receipt must.
  if (!('identity' in result) || !result.identity) return false
  const sameIdentity = (value: RunWorktreeIdentity) => sameRunWorktreeIdentity(value, identity)
  if (!sameIdentity(result.identity) || !workspaceRequestPathsAllowed(request)) return false
  if (request.kind.startsWith('git_')) {
    if (request.kind === 'git_status' || request.kind === 'git_history') return result.kind === request.kind
    if (request.kind === 'git_revert_preview') return result.kind === 'git_revert_preview' &&
      result.operationId === request.operationId && sameGitRevision(result.revision, request.revision) &&
      result.file.path === request.file.path && result.file.fileVersion === request.file.fileVersion &&
      result.before.path === request.file.path
    if (request.kind === 'git_revert_apply') return result.kind === 'git_revert_applied' &&
      result.operationId === request.operationId && result.previewVersion === request.previewVersion &&
      result.headSha === request.expected.headSha && result.after.path === request.file.path
    if (request.kind === 'git_undo') return result.kind === 'git_undone' &&
      result.operationId === request.operationId && result.undoOf === request.undoOf && result.headSha === request.expected.headSha &&
      result.files.length === request.files.files.length && result.files.every((file, index) => file.path === request.files.files[index]!.path)
    if (request.kind === 'git_checkpoint_preview') return result.kind === 'git_checkpoint_preview' &&
      result.operationId === request.operationId && sameGitRevision(result.revision, request.revision)
    if (request.kind === 'git_checkpoint_restore') return result.kind === 'git_checkpoint_restored' &&
      result.operationId === request.operationId && result.previewVersion === request.previewVersion &&
      result.checkpointId === request.checkpointId && result.headSha === request.expected.headSha
    return false
  }
  const value = result as Extract<WorkspaceReadResult, { kind: 'file' | 'tree' | 'search' | 'context' | 'diff_snapshot' | 'diff_file' }>
  if (value.kind !== request.kind) return false
  if (value.kind === 'diff_snapshot' && request.kind === 'diff_snapshot') return value.revision.source === request.source &&
    value.revision.baseSha !== null && value.revision.headSha !== null &&
    (request.source === 'working' || (value.revision.baseSha === request.baseSha && value.revision.headSha === request.headSha)) &&
    value.files.every(file => visibleWorkspacePath(file.path) && (file.previousPath === null || visibleWorkspacePath(file.previousPath)))
  if (value.kind === 'diff_file' && request.kind === 'diff_file') return value.snapshotId === request.snapshotId &&
    value.sourceVersion === request.revision.version && (['source', 'version', 'baseSha', 'headSha', 'treeSha'] as const)
      .every(key => value.revision[key] === request.revision[key]) &&
    value.file.fileVersion === request.file.fileVersion && value.file.path === request.file.path
  if (value.revision.source !== 'working') return false
  const fileMatches = (file: WorkspaceFileResult, selection: WorkspaceFileSelection) => {
    if (!sameIdentity(file.identity) || file.path !== selection.path || file.revision.source !== 'working' || !visibleWorkspacePath(file.path)) return false
    if (selection.expected && (file.revision.headSha !== selection.expected.headSha || file.contentSha256 !== selection.expected.contentSha256)) return false
    if (file.format !== 'text') return file.content === null
    return file.content !== null && file.contentSha256 !== null && file.totalLines !== null &&
      new TextEncoder().encode(file.content).byteLength <= WORKSPACE_MAX_RESPONSE_BYTES &&
      file.startLine === (selection.range?.startLine ?? 1) && file.endLine >= file.startLine &&
      file.endLine <= Math.min(selection.range?.endLine ?? 2000, file.totalLines) &&
      file.content.split('\n').length === file.endLine - file.startLine + 1
  }
  if (value.kind === 'file' && request.kind === 'file') return fileMatches(value, request)
  if (value.kind === 'tree' && request.kind === 'tree') {
    const prefix = request.path ? `${request.path}/` : ''
    return value.path === request.path && value.entries.length <= request.limit && value.entries.every(entry =>
      entry.path === `${prefix}${entry.name}` && !entry.name.includes('/') && visibleWorkspacePath(entry.path))
  }
  if (value.kind === 'search' && request.kind === 'search') return value.entries.length <= request.limit &&
    value.entries.every(entry => entry.path.toLowerCase().includes(request.query.toLowerCase()) && visibleWorkspacePath(entry.path))
  if (value.kind === 'context' && request.kind === 'context') {
    const selection = request.selection
    const files = selection.kind === 'resolved' ? selection.files : selection.kind === 'file' ? [selection] : null
    if (files && (files.length !== value.files.length || value.omitted !== 0)) return false
    let bytes = 0
    return value.files.every((file, index) => {
      bytes += new TextEncoder().encode(file.content ?? '').byteLength
      return file.format === 'text' && bytes <= 64 * 1024 && file.revision.headSha === value.revision.headSha &&
        (files ? fileMatches(file, files[index]!) : selection.kind === 'folder' &&
          (!selection.path || file.path.startsWith(`${selection.path}/`)) && fileMatches(file, { path: file.path }))
    })
  }
  return false
}

/** Delivered through the existing device work wake; no client-selected root or sandbox. */
export const workspaceReadCommand = z.strictObject({
  id: z.uuid(), identity: runWorktreeIdentity, request: workspaceReadRequest, expiresAt: z.iso.datetime(),
})
export type WorkspaceReadCommand = z.infer<typeof workspaceReadCommand>

export class CodingWorkspaceError extends Error {
  constructor(readonly code: WorkspaceErrorCode, options?: ErrorOptions) { super(code, options); this.name = 'CodingWorkspaceError' }
}
