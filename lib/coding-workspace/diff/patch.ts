import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { structuredPatch } from 'diff'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import {
  WORKSPACE_DIFF_MAX_BLOB_BYTES, WORKSPACE_DIFF_MAX_PATCH_BYTES, reviewAnchor, WorkspaceReviewError, diffFileVersionMaterial,
  type DiffFileMetadata, type DiffFilePatch, type DiffHunk, type DiffRevision, type ReviewAnchor,
} from '@mikka/protocol/coding-workspace-review'
import { maskDeep, type Masker } from '../../secrets/mask'

export const diffDigest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const quotePath = (path: string) => /[\s"\\]/u.test(path) ? JSON.stringify(path) : path

/** Unchanged files retain their Reviewed mark when another working file moves.
 * A new HEAD, path, mode, base or content on either side invalidates that mark. */
export function diffFileVersion(repoId: string, revision: Pick<DiffRevision, 'baseSha' | 'headSha'>,
  file: Omit<DiffFileMetadata, 'fileVersion' | 'additions' | 'deletions' | 'binary'>, retainedPatch?: string) {
  return diffDigest(diffFileVersionMaterial(repoId, revision, file, retainedPatch))
}

export function gitBlobHash(bytes: Buffer, objectId: string) {
  return createHash(objectId.length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}

export function sourceText(bytes: Buffer | null, objectId: string | null, mask: Masker): string | null {
  if (objectId === null) {
    if (bytes !== null) throw new WorkspaceReviewError('workspace_snapshot_unavailable')
    return ''
  }
  if (!bytes || bytes.length > WORKSPACE_DIFF_MAX_BLOB_BYTES || gitBlobHash(bytes, objectId) !== objectId)
    throw new WorkspaceReviewError('workspace_snapshot_unavailable')
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }
  catch { return null }
  if (text.includes('\0')) return null
  // Check the complete before/after source, before +/- hunk prefixes split a
  // multiline value or a range omits it. Neither proof is retained or returned.
  assertDiffSourceSafe(text, mask)
  return text
}

/** A Git clean conversion must not turn a multiline secret into a different
 * unmasked spelling. These checks reject the file; they never rewrite source. */
export function assertDiffSourceSafe(text: string, mask: Masker) {
  const lf = text.replace(/\r\n/g, '\n'), crlf = lf.replace(/\n/g, '\r\n')
  for (const form of new Set([text, lf, crlf]))
    if (mask(form) !== form) throw new CodingWorkspaceError('workspace_path_unavailable')
}

/** Retained hunks are immutable. If a newly saved secret would now be exposed,
 * refuse this artifact instead of changing its old anchors in place. */
export function assertDiffPatchSafe(patch: DiffFilePatch, mask: Masker) {
  if (!isDeepStrictEqual(maskDeep(patch.file, mask), patch.file)) throw new CodingWorkspaceError('workspace_path_unavailable')
  if (patch.patch) assertDiffSourceSafe(patch.patch, mask)
  for (const hunk of patch.hunks) {
    for (const excluded of ['+', '-']) {
      const source = hunk.lines.filter(line => !line.startsWith(excluded) && !line.startsWith('\\'))
        .map(line => line.slice(1)).join('\n')
      assertDiffSourceSafe(source, mask)
    }
  }
}

export function hunkFingerprint(sourceVersion: string, fileVersion: string, hunk: Omit<DiffHunk, 'fingerprint'>) {
  return diffDigest(JSON.stringify([sourceVersion, fileVersion, hunk.oldStart, hunk.oldLines,
    hunk.newStart, hunk.newLines, hunk.lines]))
}

/** The server constructs this from full, hash-verified blob proofs. A device's
 * arbitrary patch text cannot become either a review anchor or public content. */
export function buildDiffFilePatch(input: {
  snapshotId: string; sourceVersion: string; file: DiffFileMetadata;
  before: Buffer | null; after: Buffer | null;
}, mask: Masker): DiffFilePatch {
  const { snapshotId, sourceVersion, file } = input
  if (!isDeepStrictEqual(maskDeep(file, mask), file)) throw new CodingWorkspaceError('workspace_path_unavailable')
  const empty = (format: DiffFilePatch['format']): DiffFilePatch => ({ snapshotId, sourceVersion, file, format, patch: null, hunks: [] })
  if ([file.oldMode, file.newMode].some(mode => mode !== null && !['100644', '100755'].includes(mode))) return empty('unavailable')
  if ([input.before, input.after].some(bytes => bytes && bytes.length > WORKSPACE_DIFF_MAX_BLOB_BYTES)) return empty('too_large')
  const before = sourceText(input.before, file.oldBlob, mask), after = sourceText(input.after, file.newBlob, mask)
  if (before === null || after === null) return { ...empty('binary'), file: { ...file, binary: true } }
  const oldPath = file.previousPath ?? file.path
  const computed = structuredPatch(oldPath, file.path, before, after, undefined, undefined,
    { context: 3, stripTrailingCr: false, maxEditLength: 10_000, timeout: 100 })
  if (!computed) return empty('too_large')
  const hunks = computed.hunks.map(hunk => ({ ...hunk, fingerprint: hunkFingerprint(sourceVersion, file.fileVersion, hunk) }))
  const lines = [`diff --git ${quotePath('a/' + oldPath)} ${quotePath('b/' + file.path)}`]
  if (file.status === 'added') lines.push(`new file mode ${file.newMode}`)
  else if (file.status === 'deleted') lines.push(`deleted file mode ${file.oldMode}`)
  else if (file.oldMode !== file.newMode) lines.push(`old mode ${file.oldMode}`, `new mode ${file.newMode}`)
  if (file.previousPath) lines.push(`rename from ${quotePath(oldPath)}`, `rename to ${quotePath(file.path)}`)
  if (hunks.length) {
    lines.push(`--- ${file.status === 'added' ? '/dev/null' : quotePath('a/' + oldPath)}`,
      `+++ ${file.status === 'deleted' ? '/dev/null' : quotePath('b/' + file.path)}`)
    for (const hunk of hunks) lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines)
  }
  const patch = lines.join('\n') + '\n'
  if (Buffer.byteLength(patch) > WORKSPACE_DIFF_MAX_PATCH_BYTES) return empty('too_large')
  if (mask(patch) !== patch) throw new CodingWorkspaceError('workspace_path_unavailable')
  return { snapshotId, sourceVersion, file: { ...file, additions: hunks.reduce((sum, hunk) => sum + hunk.lines.filter(line => line.startsWith('+')).length, 0),
    deletions: hunks.reduce((sum, hunk) => sum + hunk.lines.filter(line => line.startsWith('-')).length, 0) }, format: 'text', patch, hunks }
}

/** Validate the actual lines on the selected side, not just a numeric interval.
 * The opposite side, gaps, no-newline markers and a re-anchored hunk are denied. */
export function validateReviewAnchor(input: unknown, patch: DiffFilePatch): ReviewAnchor {
  const parsed = reviewAnchor.safeParse(input)
  const invalid = () => new WorkspaceReviewError('workspace_review_anchor_invalid')
  if (!parsed.success) throw new WorkspaceReviewError('workspace_review_anchor_invalid', { cause: parsed.error })
  const anchor = parsed.data
  if (patch.format !== 'text' || anchor.snapshotId !== patch.snapshotId || anchor.sourceVersion !== patch.sourceVersion
    || anchor.path !== patch.file.path || (anchor.previousPath ?? null) !== patch.file.previousPath) throw invalid()
  const hunk = patch.hunks.find(item => item.fingerprint === anchor.hunkFingerprint)
  if (!hunk || hunk.fingerprint !== hunkFingerprint(patch.sourceVersion, patch.file.fileVersion, hunk)) throw invalid()
  let old = hunk.oldStart, next = hunk.newStart
  const present = new Set<number>()
  for (const line of hunk.lines) {
    if (line.startsWith('\\')) continue
    if (![' ', '+', '-'].includes(line[0] ?? '')) throw invalid()
    if (anchor.side === 'LEFT' && !line.startsWith('+')) present.add(old)
    if (anchor.side === 'RIGHT' && !line.startsWith('-')) present.add(next)
    if (!line.startsWith('+')) old++
    if (!line.startsWith('-')) next++
  }
  if (old !== hunk.oldStart + hunk.oldLines || next !== hunk.newStart + hunk.newLines) throw invalid()
  for (let line = anchor.lineStart; line <= anchor.lineEnd; line++) if (!present.has(line)) throw invalid()
  return anchor
}
