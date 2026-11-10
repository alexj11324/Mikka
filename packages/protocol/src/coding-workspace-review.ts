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
  /** Native patch identity is retained without retaining unverified text.
   * Page is only a bounded locator, never a source/permission capability. */
  github: z.strictObject({ repositoryId: z.string().regex(/^[1-9]\d{0,39}$/),
    patchSha256: digest.nullable(), page: z.number().int().min(1).max(30).nullable() }).optional(),
})
export type DiffFileMetadata = z.infer<typeof diffFileMetadata>
/** The same material is hashed by the daemon and the server. It deliberately
 * excludes the whole working manifest so unrelated file edits do not invalidate
 * this file's Reviewed mark. A changed HEAD or base always invalidates it. */
export function diffFileVersionMaterial(repoId: string, revision: Pick<DiffRevision, 'baseSha' | 'headSha'>,
  file: Omit<DiffFileMetadata, 'fileVersion' | 'additions' | 'deletions' | 'binary'>, retainedPatch?: string) {
  return JSON.stringify([repoId, revision.baseSha, revision.headSha, file.path, file.previousPath,
    file.status, file.oldBlob, file.newBlob, file.oldMode, file.newMode, file.workingVersion ?? null,
    file.rawBlob ?? null, file.unavailableReason ?? null, retainedPatch ?? null,
    ...(file.github ? [file.github.repositoryId, file.github.patchSha256] : [])])
}
export const diffSourceAccess = z.strictObject({ kind: z.literal('github'), repositoryId: z.string().regex(/^[1-9]\d{0,39}$/),
  pullRequestNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  pullRequestBaseSha: sha.optional(),
  /** All native PR files were reconciled with complete immutable Git trees.
   * This proves the manifest, separately from counts.complete (loaded patches). */
  manifestComplete: z.literal(true) })
export type DiffSourceAccess = z.infer<typeof diffSourceAccess>
export const diffSnapshot = z.strictObject({
  id: z.uuid(), identity: runRepositoryIdentity, taskId: z.uuid().nullable(), revision: diffRevision,
  observedAt: z.iso.datetime(), isStale: z.boolean(), availability: z.enum(['available', 'empty', 'unavailable']),
  reason: z.enum(['machine_unavailable', 'unsupported', 'missing_evidence', 'too_large', 'version_changed', 'github_unavailable']).nullable(),
  counts: z.strictObject({ files: z.number().int().nonnegative().max(WORKSPACE_DIFF_MAX_FILES),
    additions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(), complete: z.boolean() }),
  policy: z.enum(['combined_working_tree', 'retained_checkpoint', 'explicit_commits', 'whole_pull_request']),
  sourceAccess: diffSourceAccess.optional(),
  factory: z.strictObject({ taskId: z.uuid(), candidateId: z.uuid(), producerRunId: z.uuid(), sha }).optional(),
  pullRequest: z.strictObject({ number: z.number().int().positive(), url: z.url(), headSha: sha,
    /** GitHub's target tip at capture; revision.baseSha is the verified diff base. */
    baseSha: sha.optional(),
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

const githubId = z.string().regex(/^[1-9]\d{0,39}$/)
const githubNode = z.string().regex(/^[A-Za-z0-9_=-]{1,200}$/)
const githubLine = z.number().int().min(1).max(1_000_000).nullable()
export const githubReviewComment = z.strictObject({
  id: githubId, nodeId: githubNode, replyToId: githubId.nullable(),
  body: z.string().max(4000), bodyTruncated: z.boolean(), author: z.string().max(100).nullable(),
  commitSha: sha.nullable(), originalCommitSha: sha.nullable(), url: z.url(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
})
export const githubReviewThread = z.strictObject({
  id: githubNode, path, side: z.enum(['LEFT', 'RIGHT']), startSide: z.enum(['LEFT', 'RIGHT']).nullable(),
  line: githubLine, startLine: githubLine, originalLine: githubLine, originalStartLine: githubLine,
  subjectType: z.enum(['LINE', 'FILE']), resolved: z.boolean(), outdated: z.boolean(),
  comments: z.array(githubReviewComment).max(20), nextCursor: z.string().max(4096).nullable(),
})
export type GitHubReviewThread = z.infer<typeof githubReviewThread>
/** Native provider data is never silently copied into the Mikka local board.
 * Cursors separately paginate threads and a specified thread's comments. */
export const githubReviewPage = z.strictObject({
  snapshotId: z.uuid(), sourceVersion: digest, repositoryId: githubId, pullRequestNumber: z.number().int().positive(),
  observedAt: z.iso.datetime(), headSha: sha, baseSha: sha, isStale: z.boolean(),
  threads: z.array(githubReviewThread).max(20), nextCursor: z.string().max(4096).nullable(),
})
export type GitHubReviewPage = z.infer<typeof githubReviewPage>
export const githubReviewQuery = z.strictObject({ cursor: z.string().max(4096).optional(), threadId: githubNode.optional() })
export type GitHubReviewQuery = z.infer<typeof githubReviewQuery>

const request = { requestId: z.uuid(), expectedRevision: z.number().int().nonnegative() }
export const reviewedFileChange = z.strictObject({ path, fileVersion: digest, reviewed: z.boolean() })
export const reviewMutation = z.discriminatedUnion('action', [
  z.strictObject({ ...request, action: z.literal('create'), anchor: reviewAnchor,
    body: z.string().trim().min(1).max(4000), draft: z.boolean().default(true) }),
  z.strictObject({ ...request, action: z.literal('reply'), threadId: z.uuid(), body: z.string().trim().min(1).max(4000) }),
  z.strictObject({ ...request, action: z.literal('edit'), commentId: z.uuid(), body: z.string().trim().min(1).max(4000) }),
  z.strictObject({ ...request, action: z.literal('resolve'), threadId: z.uuid(), resolved: z.boolean() }),
  z.strictObject({ ...request, action: z.literal('reviewed'), files: z.array(reviewedFileChange).min(1).max(WORKSPACE_DIFF_MAX_PAGE) }),
])
export type ReviewMutation = z.infer<typeof reviewMutation>
export const reviewBatchRequest = z.strictObject({
  ...request, batchId: z.uuid(), snapshotId: z.uuid(), sourceVersion: digest,
  commentIds: z.array(z.uuid()).max(50), note: z.string().trim().max(4000).optional(),
  failedCheckRefs: z.array(z.string().min(1).max(2000)).max(100),
  factory: z.strictObject({ taskId: z.uuid(), revision: z.number().int().positive(), attemptId: z.uuid(),
    candidateId: z.uuid().nullable(), sourceEventId: z.uuid() }).optional(),
}).refine(value => value.commentIds.length > 0 || Boolean(value.note) || value.failedCheckRefs.length > 0)
export type ReviewBatchRequest = z.infer<typeof reviewBatchRequest>

const githubBatch = { ...request, batchId: z.uuid(), sourceVersion: digest }
export const githubReviewMutation = z.discriminatedUnion('action', [
  z.strictObject({ ...githubBatch, action: z.literal('publish'), event: z.enum(['COMMENT', 'REQUEST_CHANGES', 'APPROVE']),
    commentIds: z.array(z.uuid()).max(50), note: z.string().trim().max(4000) }).refine(value => value.commentIds.length > 0 || Boolean(value.note)),
  z.strictObject({ ...githubBatch, action: z.literal('reply'), commentId: githubId, body: z.string().trim().min(1).max(4000) }),
])
export type GitHubReviewMutation = z.infer<typeof githubReviewMutation>
export const reviewBatchReceipt = z.strictObject({
  batchId: z.uuid(), destination: z.enum(['agent', 'github']), state: z.enum(['prepared', 'delivering', 'accepted', 'rejected', 'uncertain']),
  sourceVersion: digest, revision: z.number().int().nonnegative(),
  reason: z.enum(['source_changed', 'authorization_changed', 'target_unavailable', 'limit_exceeded', 'delivery_uncertain']).optional(),
  delivery: z.strictObject({ kind: z.enum(['run_message', 'run_continuation', 'factory_repair', 'github_review', 'github_reply']),
    id: z.string().min(1).max(1024), url: z.url().max(2048).optional(), runId: z.uuid().optional(), messageId: z.uuid().optional(),
    headSha: sha.optional(), commitSha: sha.optional(), outdated: z.boolean().optional() }).nullable(),
})
export type ReviewBatchReceipt = z.infer<typeof reviewBatchReceipt>

/** Task review is a projection of an immutable Run snapshot. The reference
 * must travel with a draft; a Task id, path or HEAD alone is not a version. */
export const taskReviewRef = z.strictObject({ snapshotId: z.uuid(), sourceVersion: digest })
export type TaskReviewRef = z.infer<typeof taskReviewRef>
export const taskReviewLineComment = z.strictObject({ path, line: z.number().int().positive().max(1_000_000),
  side: z.enum(['old', 'new']), body: z.string().trim().min(1).max(4000) })
export const taskReviewSubmission = z.strictObject({ reviewRef: taskReviewRef,
  comments: z.array(taskReviewLineComment).max(50), note: z.string().max(4000).optional(),
  attachedChecks: z.array(z.string().min(1).max(2000)).max(100), idempotencyKey: z.string().min(1).max(200) })
  .refine(value => value.comments.length > 0 || Boolean(value.note?.trim()) || value.attachedChecks.length > 0)
export type TaskReviewSubmission = z.infer<typeof taskReviewSubmission>

export const reviewAttachedCheck = z.strictObject({ id: z.string().min(1).max(2000), name: z.string().min(1).max(200),
  status: z.literal('failed'), headSha: sha, logExcerpt: z.string().max(2000), logTruncated: z.boolean() })
export type ReviewAttachedCheck = z.infer<typeof reviewAttachedCheck>

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
      && value.revision.baseSha !== null && value.revision.headSha !== null && value.file.github === undefined),
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

export const CHECKPOINT_REVIEW_MAX_PROOF_BYTES = 4 * 1024 * 1024
/** Optional evidence is parsed separately from the recovery checkpoint. A bad
 * review envelope must not discard an otherwise valid recovery safe point. */
export const checkpointReviewEvidence = z.strictObject({
  version: z.literal(1), repoId: z.uuid(),
  revision: diffRevision.extend({ source: z.literal('checkpoint'), baseSha: sha, treeSha: sha }),
  files: z.array(diffFileMetadata).max(WORKSPACE_DIFF_MAX_FILES),
  blobs: z.array(workspaceDiffBlobProof).max(WORKSPACE_DIFF_MAX_FILES * 2),
  reason: z.enum(['missing_evidence', 'too_large', 'unsupported', 'version_changed']).nullable(),
})
export type CheckpointReviewEvidence = z.infer<typeof checkpointReviewEvidence>
