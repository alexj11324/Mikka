import 'server-only'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  matchesWorkspaceResponse, workspaceReadReceipt, type RunWorktreeIdentity,
  type WorkspaceReadRequest, type WorkspaceReadReceipt, type WorkspaceReadResult,
} from '@mikka/protocol/coding-workspace'
import { maskDeep, type Masker } from '../secrets/mask'

/** Validate in memory and return only the public result. Checking the complete
 * source prevents reconstructing a multiline secret through separate ranges.
 * Secret values remain on the server and are never sent to a daemon. */
export function validateWorkspaceReceipt(request: WorkspaceReadRequest, identity: RunWorktreeIdentity,
  receipt: WorkspaceReadReceipt, mask: Masker): WorkspaceReadResult | null {
  const parsed = workspaceReadReceipt.safeParse(receipt)
  if (!parsed.success) return null
  const { result, files } = parsed.data
  if (!matchesWorkspaceResponse(request, identity, result)) return null
  const textFiles = !result.ok ? [] : result.kind === 'file' ? (result.format === 'text' ? [result] : [])
    : result.kind === 'context' ? result.files : []
  const expected = new Set(textFiles.map(file => file.path))
  if (files.length !== expected.size || new Set(files.map(file => file.path)).size !== files.length ||
    files.some(file => !expected.has(file.path))) return null
  const sources = new Map<string, { bytes: Buffer; text: string; hash: string }>()
  let blocked = result.ok && !isDeepStrictEqual(maskDeep(result, mask), result)
  for (const file of files) {
    const bytes = Buffer.from(file.base64, 'base64')
    if (bytes.toString('base64') !== file.base64) return null
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { return null }
    if (text.includes('\0')) return null
    if (mask(text) !== text) blocked = true
    sources.set(file.path, { bytes, text, hash: createHash('sha256').update(bytes).digest('hex') })
  }
  for (const file of textFiles) {
    const source = sources.get(file.path)!
    const lines = source.text.split('\n')
    if (file.size !== source.bytes.length || file.contentSha256 !== source.hash || file.totalLines !== lines.length ||
      file.content !== lines.slice(file.startLine - 1, file.endLine).join('\n') ||
      file.truncated !== (file.startLine > 1 || file.endLine < lines.length)) return null
  }
  return blocked ? { ok: false, code: 'workspace_path_unavailable' } : result
}
