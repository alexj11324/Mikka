import 'server-only'
import { WORKSPACE_DIFF_MAX_BLOB_BYTES, WORKSPACE_DIFF_MAX_PATCH_BYTES, WorkspaceReviewError,
  type DiffFileMetadata, type DiffFilePatch, type DiffHunk } from '@mikka/protocol/coding-workspace-review'
import { maskDeep, type Masker } from '../../secrets/mask'
import { isDeepStrictEqual } from 'node:util'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { assertDiffPatchSafe, hunkFingerprint, sourceText } from './patch'

const unavailable = () => new WorkspaceReviewError('workspace_snapshot_unavailable')
const quotePath = (value: string) => /[\s"\\]/u.test(value) ? JSON.stringify(value) : value
type Line = { text: string; terminated: boolean }
function sourceLines(value: string): Line[] {
  if (!value) return []
  const terminated = value.endsWith('\n'), lines = value.split('\n')
  if (terminated) lines.pop()
  return lines.map((text, index) => ({ text, terminated: index < lines.length - 1 || terminated }))
}

/** A native GitHub hunk is an anchor, not a suggestion for a fuzzy patch.
 * Check every old/new coordinate, unchanged gap, source byte and EOF marker
 * against the complete verified blobs. Never search for a matching offset. */
export function buildGitHubFilePatch(input: {
  snapshotId: string; sourceVersion: string; file: DiffFileMetadata;
  before: Buffer | null; after: Buffer | null; nativePatch: string | null;
}, mask: Masker): DiffFilePatch {
  const { snapshotId, sourceVersion, file, nativePatch } = input
  const empty = (format: DiffFilePatch['format']): DiffFilePatch => ({ snapshotId, sourceVersion, file, format, patch: null, hunks: [] })
  if (!isDeepStrictEqual(maskDeep(file, mask), file)) throw new CodingWorkspaceError('workspace_path_unavailable')
  if ([file.oldMode, file.newMode].some(mode => mode !== null && !['100644', '100755'].includes(mode))) return empty('unavailable')
  if ([input.before, input.after].some(bytes => bytes && bytes.length > WORKSPACE_DIFF_MAX_BLOB_BYTES)) return empty('too_large')
  const before = sourceText(input.before, file.oldBlob, mask), after = sourceText(input.after, file.newBlob, mask)
  if (before === null || after === null) return { ...empty('binary'), file: { ...file, binary: true } }
  if (nativePatch === null) return empty('unavailable')
  if (Buffer.byteLength(nativePatch) > WORKSPACE_DIFF_MAX_PATCH_BYTES) return empty('too_large')
  const original = sourceLines(before), updated = sourceLines(after), patchLines = nativePatch.split('\n')
  if (nativePatch.endsWith('\n')) patchLines.pop()
  if (!patchLines.length || !nativePatch) throw unavailable()
  const hunks: DiffHunk[] = []
  let index = 0, oldPosition = 0, newPosition = 0, additions = 0, deletions = 0
  const matches = (source: Line[], position: number, line: Line) => position < source.length
    && source[position]!.text === line.text && source[position]!.terminated === line.terminated
  const gap = (oldEnd: number, newEnd: number) => {
    if (oldEnd < oldPosition || newEnd < newPosition || oldEnd > original.length || newEnd > updated.length
      || oldEnd - oldPosition !== newEnd - newPosition) throw unavailable()
    while (oldPosition < oldEnd) {
      if (!matches(updated, newPosition, original[oldPosition]!)) throw unavailable()
      oldPosition++; newPosition++
    }
  }
  while (index < patchLines.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(patchLines[index++]!)
    if (!header || hunks.length >= 10_000) throw unavailable()
    const oldStart = Number(header[1]), oldLines = Number(header[2] ?? 1)
    const newStart = Number(header[3]), newLines = Number(header[4] ?? 1)
    if ([oldStart, oldLines, newStart, newLines].some(value => !Number.isSafeInteger(value) || value > 1_000_000)
      || (oldLines > 0 && oldStart === 0) || (newLines > 0 && newStart === 0) || (oldLines === 0 && newLines === 0)) throw unavailable()
    gap(oldLines ? oldStart - 1 : oldStart, newLines ? newStart - 1 : newStart)
    const oldBegin = oldPosition, newBegin = newPosition, lines: string[] = []
    const content: { prefix: string; line: Line }[] = []
    while (index < patchLines.length && !patchLines[index]!.startsWith('@@ ')) {
      const value = patchLines[index++]!
      if (lines.length >= 50_000) throw unavailable()
      lines.push(value)
      if (value === '\\ No newline at end of file') {
        const previous = content.at(-1)
        if (!previous || !previous.line.terminated) throw unavailable()
        previous.line.terminated = false
      } else {
        const prefix = value[0]
        if (prefix !== ' ' && prefix !== '+' && prefix !== '-') throw unavailable()
        content.push({ prefix, line: { text: value.slice(1), terminated: true } })
      }
    }
    for (const item of content) {
      if (item.prefix !== '+') {
        if (!matches(original, oldPosition, item.line)) throw unavailable()
        oldPosition++
      }
      if (item.prefix !== '-') {
        if (!matches(updated, newPosition, item.line)) throw unavailable()
        newPosition++
      }
      if (item.prefix === '+') additions++
      else if (item.prefix === '-') deletions++
    }
    if (oldPosition - oldBegin !== oldLines || newPosition - newBegin !== newLines) throw unavailable()
    const hunk = { oldStart, oldLines, newStart, newLines, lines }
    hunks.push({ ...hunk, fingerprint: hunkFingerprint(sourceVersion, file.fileVersion, hunk) })
  }
  gap(original.length, updated.length)
  const oldPath = file.previousPath ?? file.path
  const headers = [`diff --git ${quotePath('a/' + oldPath)} ${quotePath('b/' + file.path)}`]
  if (file.status === 'added') headers.push(`new file mode ${file.newMode}`)
  else if (file.status === 'deleted') headers.push(`deleted file mode ${file.oldMode}`)
  else if (file.oldMode !== file.newMode) headers.push(`old mode ${file.oldMode}`, `new mode ${file.newMode}`)
  if (file.previousPath) headers.push(`rename from ${quotePath(oldPath)}`, `rename to ${quotePath(file.path)}`)
  headers.push(`--- ${file.status === 'added' ? '/dev/null' : quotePath('a/' + oldPath)}`,
    `+++ ${file.status === 'deleted' ? '/dev/null' : quotePath('b/' + file.path)}`)
  const patch = headers.join('\n') + '\n' + nativePatch + (nativePatch.endsWith('\n') ? '' : '\n')
  if (Buffer.byteLength(patch) > WORKSPACE_DIFF_MAX_PATCH_BYTES) return empty('too_large')
  const result: DiffFilePatch = { snapshotId, sourceVersion, file: { ...file, additions, deletions }, format: 'text', patch, hunks }
  assertDiffPatchSafe(result, mask)
  return result
}
