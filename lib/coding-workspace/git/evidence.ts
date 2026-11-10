import { createHash } from 'node:crypto'
import { structuredPatch } from 'diff'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import type { DiffFileMetadata, DiffRevision } from '@mikka/protocol/coding-workspace-review'
import { WORKSPACE_GIT_MAX_PATCH_BYTES, type GitRevertAfter, type GitRevertFile, type GitRevertTarget } from '@mikka/protocol/coding-workspace-git'
import { assertDiffSourceSafe, gitBlobHash, hunkFingerprint } from '../diff/patch'
import type { Masker } from '../../secrets/mask'

export const gitDigest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const quotePath = (path: string) => /[\s"\\]/u.test(path) ? JSON.stringify(path) : path
const unsupported = () => new CodingWorkspaceError('workspace_unsupported')
const conflict = () => new CodingWorkspaceError('workspace_version_conflict')

function text(bytes: Buffer | null): string | null {
  if (bytes === null) return null
  try {
    const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    return value.includes('\0') ? null : value
  } catch { return null }
}

/** Verify the complete base/current proof pair against the immutable snapshot
 * metadata. The server, not the device, decides the reverted bytes. */
export function verifyRevertProofs(file: GitRevertFile, revision: DiffRevision,
  proofs: { sha: string; base64: string; clean?: 'crlf_to_lf'; rawSha?: string }[]) {
  if (proofs.length > 2) return null
  const wanted = [file.oldBlob, file.newBlob].filter((sha): sha is string => sha !== null)
  if (proofs.length !== wanted.length || new Set(proofs.map(proof => proof.sha)).size !== proofs.length) return null
  const bytes = new Map<string, { raw: Buffer; clean?: boolean }>()
  for (const proof of proofs) {
    const raw = Buffer.from(proof.base64, 'base64')
    if (!wanted.includes(proof.sha) || raw.toString('base64') !== proof.base64 || Boolean(proof.clean) !== Boolean(proof.rawSha)) return null
    if (proof.clean) {
      if (revision.source !== 'working' || proof.sha !== file.newBlob || proof.rawSha !== file.rawBlob
        || file.rawSize === undefined || raw.length !== file.rawSize || gitBlobHash(raw, proof.rawSha!) !== proof.rawSha) return null
      const cleaned = Buffer.from(raw.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')
      if (gitBlobHash(cleaned, proof.sha) !== proof.sha) return null
      bytes.set(proof.sha, { raw, clean: true })
    } else {
      if (proof.sha === file.newBlob && (file.rawBlob !== undefined || file.rawSize !== undefined)) return null
      if (gitBlobHash(raw, proof.sha) !== proof.sha) return null
      bytes.set(proof.sha, { raw })
    }
  }
  if (file.oldBlob && file.oldSize != null && bytes.get(file.oldBlob)!.raw.length !== file.oldSize) return null
  if (file.newBlob && file.newSize != null && bytes.get(file.newBlob)!.raw.length !== file.newSize) return null
  return {
    base: file.oldBlob ? bytes.get(file.oldBlob)!.raw : null,
    before: file.newBlob ? bytes.get(file.newBlob)!.raw : null,
  }
}

export function revertedAfter(file: GitRevertFile, revision: DiffRevision, target: GitRevertTarget,
  before: Buffer | null, base: Buffer | null): { after: GitRevertAfter; bytes: Buffer | null } {
  if (target.kind === 'file') {
    const bytes = base
    return { bytes, after: bytes === null ? { exists: false, mode: null, contentSha256: null }
      : { exists: true, mode: file.oldMode, contentSha256: gitDigest(bytes) } }
  }
  const bytes = revertHunks(file, revision.version, target.fingerprints, before, base)
  return { bytes, after: { exists: true, mode: file.newMode, contentSha256: gitDigest(bytes) } }
}

/** Recompute the exact working diff from verified bytes, then replace only the
 * selected new-side ranges with their old side. Unselected hunks are never
 * touched, so a client cannot smuggle a second edit into a hunk revert. */
export function revertHunks(file: GitRevertFile, sourceVersion: string, fingerprints: string[],
  before: Buffer | null, base: Buffer | null): Buffer {
  const beforeText = text(before), baseText = text(base)
  if (beforeText === null || baseText === null) throw unsupported()
  const computed = structuredPatch(file.path, file.path, baseText, beforeText, undefined, undefined,
    { context: 3, stripTrailingCr: false, maxEditLength: 10_000, timeout: 100 })
  if (!computed) throw unsupported()
  const hunks = computed.hunks.map(hunk => ({ ...hunk, fingerprint: hunkFingerprint(sourceVersion, file.fileVersion, hunk) }))
  const selected = new Set(fingerprints)
  const chosen = hunks.filter(hunk => selected.has(hunk.fingerprint))
  if (chosen.length !== selected.size) throw conflict()
  const lines = beforeText.split('\n')
  for (const hunk of [...chosen].sort((left, right) => right.newStart - left.newStart)) {
    const oldLines = hunk.lines.filter(line => !line.startsWith('+')).map(line => line.slice(1))
    lines.splice(Math.max(hunk.newStart - 1, 0), hunk.newLines, ...oldLines)
  }
  return Buffer.from(lines.join('\n'), 'utf8')
}

/** The person sees the exact inverse change. Binary or over-budget content
 * still previews as metadata with a null patch, never as a truncated diff. */
export function inversePatch(input: { file: GitRevertFile; before: Buffer | null; after: Buffer | null; mask: Masker }) {
  const { file, before, after, mask } = input
  const beforeText = text(before), afterText = text(after)
  if ((before && beforeText === null) || (after && afterText === null)) return { patch: null, additions: 0, deletions: 0 }
  const oldText = beforeText ?? '', newText = afterText ?? ''
  const computed = structuredPatch(file.path, file.path, oldText, newText, undefined, undefined,
    { context: 3, stripTrailingCr: false, maxEditLength: 10_000, timeout: 100 })
  if (!computed) return { patch: null, additions: 0, deletions: 0 }
  const lines = [`diff --git ${quotePath(`a/${file.path}`)} ${quotePath(`b/${file.path}`)}`]
  if (!before) lines.push(`new file mode ${file.oldMode}`)
  if (!after) lines.push(`deleted file mode ${file.newMode}`)
  lines.push(`--- ${before ? quotePath(`a/${file.path}`) : '/dev/null'}`, `+++ ${after ? quotePath(`b/${file.path}`) : '/dev/null'}`)
  for (const hunk of computed.hunks) lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines)
  const patch = lines.join('\n') + '\n'
  if (Buffer.byteLength(patch) > WORKSPACE_GIT_MAX_PATCH_BYTES) return { patch: null, additions: 0, deletions: 0 }
  if (before) assertDiffSourceSafe(oldText, mask)
  if (after) assertDiffSourceSafe(newText, mask)
  if (mask(patch) !== patch) throw new CodingWorkspaceError('workspace_path_unavailable')
  return { patch, additions: computed.hunks.reduce((sum, hunk) => sum + hunk.lines.filter(line => line.startsWith('+')).length, 0),
    deletions: computed.hunks.reduce((sum, hunk) => sum + hunk.lines.filter(line => line.startsWith('-')).length, 0) }
}

/** A preview must not claim a file/mode result the snapshot did not have. */
export function revertFileConsistent(file: DiffFileMetadata, request: GitRevertFile) {
  return file.path === request.path && file.previousPath === null && file.fileVersion === request.fileVersion
    && file.status === request.status && file.oldBlob === request.oldBlob && file.newBlob === request.newBlob
    && file.oldMode === request.oldMode && file.newMode === request.newMode
    && file.rawBlob === request.rawBlob && file.rawSize === request.rawSize
    && [file.oldMode, file.newMode].every(mode => mode === null || mode === '100644' || mode === '100755')
    && !['renamed', 'unavailable'].includes(file.status)
}
