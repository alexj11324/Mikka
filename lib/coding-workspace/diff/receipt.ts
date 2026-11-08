import { isDeepStrictEqual } from 'node:util'
import { CodingWorkspaceError, type WorkspaceReadReceipt, type WorkspaceReadResult } from '@mikka/protocol/coding-workspace'
import { WORKSPACE_DIFF_MAX_BLOB_BYTES, WorkspaceReviewError, type WorkspaceDiffReadRequest } from '@mikka/protocol/coding-workspace-review'
import { maskDeep, type Masker } from '../../secrets/mask'
import { assertDiffSourceSafe, buildDiffFilePatch, diffDigest, diffFileVersion, gitBlobHash } from './patch'

/** Never trust a device-authored public patch. Only complete hash-verified
 * blob proofs may produce hunks; proofs are consumed in memory and discarded. */
export function validateDiffReceipt(request: WorkspaceDiffReadRequest, receipt: WorkspaceReadReceipt, mask: Masker): WorkspaceReadResult | null {
  const { result, files } = receipt, proofs = receipt.blobs ?? []
  if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024) return null
  if (files.length) return null
  if (!result.ok) return proofs.length ? null : result
  if (!isDeepStrictEqual(maskDeep(result, mask), result)) return { ok: false, code: 'workspace_path_unavailable' }
  if (result.kind === 'diff_snapshot' && request.kind === 'diff_snapshot') {
    if (proofs.length || result.files.some(file => file.github !== undefined)
      || new Set(result.files.map(file => file.path)).size !== result.files.length) return null
    if (result.files.some(file => file.fileVersion !== diffFileVersion(result.identity.repoId, result.revision, file))) return null
    if (result.revision.version !== diffDigest(JSON.stringify([result.revision.source, result.revision.baseSha, result.revision.headSha,
      result.revision.treeSha, result.files.map(file => file.fileVersion)]))) return null
    return result
  }
  if (result.kind !== 'diff_file' || request.kind !== 'diff_file' || result.file.github !== undefined || request.file.github !== undefined
    || !isDeepStrictEqual(result.file, request.file)
    || result.patch !== null || result.hunks.length) return null
  const { file } = request
  const unavailable = [file.oldMode, file.newMode].some(mode => mode !== null && !['100644', '100755'].includes(mode))
  const large = [file.oldSize, file.newSize, file.rawSize].some(size => size != null && size > WORKSPACE_DIFF_MAX_BLOB_BYTES)
  if (unavailable || large) return proofs.length ? null : { ...result, format: unavailable ? 'unavailable' : 'too_large', patch: null, hunks: [] }
  if ((file.oldMode !== null && file.oldBlob === null) || (file.newMode !== null && file.newBlob === null)) return null
  const wanted = new Set([file.oldBlob, file.newBlob].filter((sha): sha is string => sha !== null))
  if (proofs.length !== wanted.size || new Set(proofs.map(proof => proof.sha)).size !== proofs.length) return null
  const bytes = new Map<string, Buffer>()
  for (const proof of proofs) {
    let value = Buffer.from(proof.base64, 'base64')
    if (!wanted.has(proof.sha) || value.length > WORKSPACE_DIFF_MAX_BLOB_BYTES || value.toString('base64') !== proof.base64
      || Boolean(proof.clean) !== Boolean(proof.rawSha)) return null
    if (proof.clean) {
      if (request.revision.source !== 'working' || proof.sha !== file.newBlob || proof.rawSha !== file.rawBlob
        || file.rawSize !== value.length || gitBlobHash(value, proof.rawSha!) !== proof.rawSha) return null
      // Check complete raw bytes before normalizing. The canonical source is
      // independently checked again by buildDiffFilePatch below.
      let rawText: string | null = null
      try { rawText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value) }
      catch (error) { if (!(error instanceof TypeError)) throw error }
      if (rawText !== null) {
        try { assertDiffSourceSafe(rawText, mask) }
        catch (error) { if (error instanceof CodingWorkspaceError) return { ok: false, code: error.code }; throw error }
      }
      value = Buffer.from(value.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')
    } else if (proof.sha === file.newBlob && (file.rawBlob !== undefined || file.rawSize !== undefined)) return null
    if (gitBlobHash(value, proof.sha) !== proof.sha) return null
    bytes.set(proof.sha, value)
  }
  if ((file.oldBlob && file.oldSize != null && bytes.get(file.oldBlob)!.length !== file.oldSize)
    || (file.newBlob && file.newSize != null && bytes.get(file.newBlob)!.length !== file.newSize)) return null
  try {
    const patch = buildDiffFilePatch({ snapshotId: request.snapshotId, sourceVersion: request.revision.version, file,
      before: file.oldBlob ? bytes.get(file.oldBlob)! : null, after: file.newBlob ? bytes.get(file.newBlob)! : null }, mask)
    return { ...result, ...patch }
  } catch (error) {
    if (error instanceof CodingWorkspaceError) return { ok: false, code: error.code }
    if (error instanceof WorkspaceReviewError) return null
    throw error
  }
}
