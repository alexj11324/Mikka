import { z } from 'zod'
import { runWorktreeIdentity, sourceRevision, visibleWorkspacePath, workspacePath } from './coding-workspace-common'

export const WORKSPACE_DIFF_MAX_FILES = 20_000
export const WORKSPACE_DIFF_MAX_PATCH_BYTES = 512 * 1024
export const WORKSPACE_DIFF_MAX_BLOB_BYTES = 1024 * 1024
export const WORKSPACE_DIFF_MAX_PAGE = 100
export const WORKSPACE_DIFF_REQUEST_HEADER = 'x-mikka-coding-workspace-diff'
const sha = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const path = workspacePath.refine(value => Boolean(value) && visibleWorkspacePath(value))

/** Historical evidence keeps repository identity without claiming a live VM. */
export const runRepositoryIdentity = runWorktreeIdentity.omit({ deviceId: true, bindingId: true })
export type RunRepositoryIdentity = z.infer<typeof runRepositoryIdentity>
export const diffSource = z.enum(['working', 'checkpoint', 'commit', 'pull_request'])
export type DiffSource = z.infer<typeof diffSource>
export const diffSelection = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('auto') }),
  z.strictObject({ source: z.literal('working') }),
  z.strictObject({ source: z.literal('checkpoint') }),
  z.strictObject({ source: z.literal('commit'), baseSha: sha, headSha: sha }),
  // The associated PR comes from the Run/Factory publication, never a caller URL.
  z.strictObject({ source: z.literal('pull_request') }),
])
export type DiffSelection = z.infer<typeof diffSelection>
export const diffRevision = sourceRevision.extend({ treeSha: sha.nullable() })
export type DiffRevision = z.infer<typeof diffRevision>

export const diffFileMetadata = z.strictObject({
  path, previousPath: path.nullable(), status: z.enum(['added', 'deleted', 'renamed', 'modified', 'unavailable']),
  oldBlob: sha.nullable(), newBlob: sha.nullable(), oldMode: z.string().regex(/^[0-7]{6}$/).nullable(),
  newMode: z.string().regex(/^[0-7]{6}$/).nullable(),
  additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(),
  binary: z.boolean(), fileVersion: digest,
  oldSize: z.number().int().nonnegative().nullable().optional(), newSize: z.number().int().nonnegative().nullable().optional(),
  /** A built-in clean conversion keeps its raw working proof private. */
  rawBlob: sha.optional(), rawSize: z.number().int().nonnegative().optional(),
  unavailableReason: z.enum(['file_type', 'custom_conversion', 'unmerged_index', 'conversion_limit']).optional(),
  /** Opaque stat/content fence for live files whose bytes exceed the read cap. */
  workingVersion: digest.optional(),
})
export type DiffFileMetadata = z.infer<typeof diffFileMetadata>
/** The same material is hashed by the daemon and the server. It deliberately
 * excludes the whole working manifest so unrelated file edits do not invalidate
 * this file's Reviewed mark. A changed HEAD or base always invalidates it. */
export function diffFileVersionMaterial(repoId: string, revision: Pick<DiffRevision, 'baseSha' | 'headSha'>,
  file: Omit<DiffFileMetadata, 'fileVersion' | 'additions' | 'deletions' | 'binary'>, retainedPatch?: string) {
  return JSON.stringify([repoId, revision.baseSha, revision.headSha, file.path, file.previousPath,
    file.status, file.oldBlob, file.newBlob, file.oldMode, file.newMode, file.workingVersion ?? null,
    file.rawBlob ?? null, file.unavailableReason ?? null, retainedPatch ?? null])
}
export const diffSnapshot = z.strictObject({
  id: z.uuid(), identity: runRepositoryIdentity, taskId: z.uuid().nullable(), revision: diffRevision,
  observedAt: z.iso.datetime(), isStale: z.boolean(), availability: z.enum(['available', 'empty', 'unavailable']),
  reason: z.enum(['machine_unavailable', 'unsupported', 'missing_evidence', 'too_large', 'version_changed', 'github_unavailable']).nullable(),
  counts: z.strictObject({ files: z.number().int().nonnegative().max(WORKSPACE_DIFF_MAX_FILES),
    additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(), complete: z.boolean() }),
  policy: z.enum(['combined_working_tree', 'retained_checkpoint', 'explicit_commits', 'whole_pull_request']),
  pullRequest: z.strictObject({ number: z.number().int().positive(), url: z.url(), headSha: sha,
    state: z.enum(['open', 'closed', 'merged']) }).nullable(),
})
export type DiffSnapshot = z.infer<typeof diffSnapshot>

export const reviewAnchor = z.strictObject({
  snapshotId: z.uuid(), sourceVersion: digest, path, previousPath: path.optional(),
  side: z.enum(['LEFT', 'RIGHT']), lineStart: z.number().int().min(1).max(1_000_000),
  lineEnd: z.number().int().min(1).max(1_000_000), hunkFingerprint: digest,
}).refine(value => value.lineEnd >= value.lineStart && value.lineEnd - value.lineStart < 2000)
export type ReviewAnchor = z.infer<typeof reviewAnchor>
export const diffHunk = z.strictObject({
  fingerprint: digest, oldStart: z.number().int().nonnegative(), oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(), newLines: z.number().int().nonnegative(),
  lines: z.array(z.string()).max(50_000),
})
export type DiffHunk = z.infer<typeof diffHunk>
export const diffFilePatch = z.strictObject({
  snapshotId: z.uuid(), sourceVersion: digest, file: diffFileMetadata,
  format: z.enum(['text', 'binary', 'too_large', 'unavailable']), patch: z.string().nullable(),
  hunks: z.array(diffHunk).max(10_000),
})
export type DiffFilePatch = z.infer<typeof diffFilePatch>

export const diffFilePage = z.strictObject({
  snapshot: diffSnapshot, boardRevision: z.number().int().nonnegative(),
  files: z.array(diffFileMetadata.extend({ reviewed: z.boolean(), reviewedAt: z.iso.datetime().nullable() })).max(WORKSPACE_DIFF_MAX_PAGE),
  nextCursor: z.string().nullable(),
})
export type DiffFilePage = z.infer<typeof diffFilePage>

export const reviewComment = z.strictObject({
  id: z.uuid(), threadId: z.uuid(), userId: z.string(), anchor: reviewAnchor, body: z.string(),
  draft: z.boolean(), resolved: z.boolean(), outdated: z.boolean(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
})
export type ReviewComment = z.infer<typeof reviewComment>
export const reviewBoard = z.strictObject({
  revision: z.number().int().nonnegative(), snapshot: diffSnapshot,
  comments: z.array(reviewComment).max(100), nextCursor: z.string().nullable(),
  permissions: z.strictObject({ canComment: z.boolean(), canSendToAgent: z.boolean(), canReadLive: z.boolean() }),
})
export type ReviewBoard = z.infer<typeof reviewBoard>

const request = { requestId: z.uuid(), expectedRevision: z.number().int().nonnegative() }
export const reviewMutation = z.discriminatedUnion('action', [
  z.strictObject({ ...request, action: z.literal('create'), anchor: reviewAnchor,
    body: z.string().trim().min(1).max(4000), draft: z.boolean().default(true) }),
  z.strictObject({ ...request, action: z.literal('reply'), threadId: z.uuid(), body: z.string().trim().min(1).max(4000) }),
  z.strictObject({ ...request, action: z.literal('edit'), commentId: z.uuid(), body: z.string().trim().min(1).max(4000) }),
  z.strictObject({ ...request, action: z.literal('resolve'), threadId: z.uuid(), resolved: z.boolean() }),
  z.strictObject({ ...request, action: z.literal('reviewed'), files: z.array(z.strictObject({ path, fileVersion: digest,
    reviewed: z.boolean() })).min(1).max(WORKSPACE_DIFF_MAX_PAGE) }),
])
export type ReviewMutation = z.infer<typeof reviewMutation>
export const reviewBatchRequest = z.strictObject({
  ...request, batchId: z.uuid(), snapshotId: z.uuid(), sourceVersion: digest,
  commentIds: z.array(z.uuid()).max(50), note: z.string().trim().max(4000).optional(),
  failedCheckRefs: z.array(z.string().min(1).max(2000)).max(100),
}).refine(value => value.commentIds.length > 0 || Boolean(value.note) || value.failedCheckRefs.length > 0)
export type ReviewBatchRequest = z.infer<typeof reviewBatchRequest>

export const WORKSPACE_REVIEW_ERROR_CODES = [
  'workspace_snapshot_unavailable', 'workspace_snapshot_outdated', 'workspace_review_conflict',
  'workspace_review_anchor_invalid', 'workspace_review_unavailable', 'workspace_review_delivery_uncertain',
  'workspace_review_github_unavailable', 'workspace_review_github_forbidden',
] as const
export type WorkspaceReviewErrorCode = typeof WORKSPACE_REVIEW_ERROR_CODES[number]
export class WorkspaceReviewError extends Error {
  constructor(readonly code: WorkspaceReviewErrorCode, options?: ErrorOptions) { super(code, options); this.name = 'WorkspaceReviewError' }
}

/** Private daemon requests use the existing bounded device-work channel. The
 * public snapshot id is allocated by the server; no machine root is accepted. */
export const workspaceDiffReadRequest = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('diff_snapshot'), source: z.enum(['working', 'commit']),
    baseSha: sha.optional(), headSha: sha.optional() }).refine(value => value.source === 'working'
      ? value.baseSha === undefined && value.headSha === undefined : Boolean(value.baseSha && value.headSha)),
  z.strictObject({ kind: z.literal('diff_file'), snapshotId: z.uuid(), revision: diffRevision,
    file: diffFileMetadata }).refine(value => ['working', 'commit'].includes(value.revision.source)
      && value.revision.baseSha !== null && value.revision.headSha !== null),
])
export type WorkspaceDiffReadRequest = z.infer<typeof workspaceDiffReadRequest>
const wireObservation = { ok: z.literal(true), identity: runWorktreeIdentity, revision: diffRevision,
  observedAt: z.iso.datetime(), availability: z.literal('online') }
export const workspaceDiffReadResult = z.union([
  z.strictObject({ ...wireObservation, kind: z.literal('diff_snapshot'), files: z.array(diffFileMetadata).max(WORKSPACE_DIFF_MAX_FILES) }),
  diffFilePatch.extend({ ...wireObservation, kind: z.literal('diff_file') }),
])
export type WorkspaceDiffReadResult = z.infer<typeof workspaceDiffReadResult>
const encodedBlob = z.string().max(Math.ceil(WORKSPACE_DIFF_MAX_BLOB_BYTES / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
export const workspaceDiffBlobProof = z.strictObject({ sha, base64: encodedBlob,
  /** base64 is the complete raw file; the server verifies and converts it. */
  clean: z.literal('crlf_to_lf').optional(), rawSha: sha.optional(),
}).refine(value => Boolean(value.clean) === Boolean(value.rawSha))
