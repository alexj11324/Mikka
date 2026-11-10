import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import type { RunWorktreeIdentity, WorkspaceReadReceipt, WorkspaceReadRequest } from '@mikka/protocol/coding-workspace'
import { gitRevertPreviewVersion, type GitRevertFile } from '@mikka/protocol/coding-workspace-git'
import type { DiffRevision } from '@mikka/protocol/coding-workspace-review'
import type { Masker } from '../../secrets/mask'
import { gitBlobHash } from '../diff/patch'
import { validateWorkspaceReceipt } from '../receipt'

/** The receipt boundary is the only place a device claim becomes a public
 * result. These cases pin that boundary without a checkout, so a contract
 * mismatch is caught even where the descriptor writer cannot run. */
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const mask: Masker = Object.assign((value: string) => value, { sourcePolicy: 'd'.repeat(64) })
const object = (letter: string) => letter.repeat(40)
const baseSha = object('a'), headSha = object('b')
const operationId = '00000000-0000-4000-8000-000000000000'
const identity: RunWorktreeIdentity = {
  version: 1, runId: '11111111-1111-4111-8111-111111111111', repoId: '22222222-2222-4222-8222-222222222222',
  deviceId: '33333333-3333-4333-8333-333333333333', workspaceId: '44444444-4444-4444-8444-444444444444',
  ownerId: 'git-owner', repositoryKey: 'github.com/mikka-fixtures/git-history', bindingId: 'e'.repeat(64),
}
const working = { source: 'working' as const, baseSha, headSha, version: 'c'.repeat(64) }
const revision: DiffRevision = { ...working, treeSha: null }
const observedAt = '2026-11-10T10:00:00.000Z'
const base = Buffer.from('line01\n'), before = Buffer.from('LINE01\n')
const file: GitRevertFile = {
  path: 'src/a.ts', previousPath: null, status: 'modified',
  oldBlob: gitBlobHash(base, baseSha), newBlob: gitBlobHash(before, headSha),
  oldMode: '100644', newMode: '100644', oldSize: base.length, newSize: before.length,
  binary: false, fileVersion: 'f'.repeat(64),
}
const metadata = { path: file.path, previousPath: null, status: 'modified' as const,
  oldBlob: file.oldBlob, newBlob: file.newBlob, oldMode: '100644', newMode: '100644',
  additions: 1, deletions: 1, binary: false, fileVersion: file.fileVersion, oldSize: base.length, newSize: before.length }
const fence = { headSha, path: file.path, exists: true, mode: '100644' as const, size: before.length,
  contentSha256: digest(before), workingVersion: '9'.repeat(64) }
const after = { exists: true, mode: '100644' as const, contentSha256: digest(base) }

test('a Git status receipt must carry the bound identity and a self-consistent fence', () => {
  const request: WorkspaceReadRequest = { kind: 'git_status' }
  const result: WorkspaceReadReceipt['result'] = { ok: true, identity, observedAt, availability: 'online', kind: 'git_status',
    revision: working, commitSha: headSha, workingTreeVersion: working.version,
    branch: { headSha, baseSha, branch: 'main', detached: false, upstream: null }, entries: [], truncated: false }
  assert.equal(validateWorkspaceReceipt(request, identity, { result, files: [] }, mask)?.ok, true)
  assert.equal(validateWorkspaceReceipt(request, identity,
    { result: { ...result, identity: { ...identity, repoId: '55555555-5555-4555-8555-555555555555' } }, files: [] }, mask), null)
  // A status whose fence does not match its own revision is refused, not normalized.
  assert.equal(validateWorkspaceReceipt(request, identity,
    { result: { ...result, workingTreeVersion: '8'.repeat(64) }, files: [] }, mask), null)
})

test('a revert preview is rebuilt from verified blob proofs, never from the claim', () => {
  const request: WorkspaceReadRequest = { kind: 'git_revert_preview', operationId, revision, file, target: { kind: 'file' } }
  const result: WorkspaceReadReceipt['result'] = { ok: true, identity, observedAt, availability: 'online', kind: 'git_revert_preview',
    operationId, revision, file: metadata, target: { kind: 'file' as const }, before: fence }
  const blobs = [{ sha: file.oldBlob!, base64: base.toString('base64') },
    { sha: file.newBlob!, base64: before.toString('base64') }]
  const preview = validateWorkspaceReceipt(request, identity, { result, files: [], blobs }, mask)
  assert.equal(preview?.ok, true)
  if (!preview || !preview.ok || preview.kind !== 'git_revert_preview' || !('previewVersion' in preview)) throw new Error('preview_missing')
  assert.equal(preview.previewVersion, gitRevertPreviewVersion({ operationId, revision, file,
    target: { kind: 'file' }, before: fence, after }))
  assert.equal(preview.after.contentSha256, digest(base))
  assert.equal(Buffer.from(preview.afterContentBase64!, 'base64').equals(base), true)
  assert.ok(preview.patch?.includes('+line01') && preview.patch.includes('-LINE01'))
  // A proof whose bytes do not hash to its claimed blob is refused outright.
  assert.equal(validateWorkspaceReceipt(request, identity,
    { result, files: [], blobs: [{ ...blobs[0]!, base64: Buffer.from('tampered').toString('base64') }, blobs[1]!] }, mask), null)
  // Proofs alone are not enough: the receipt's own fence must match them.
  assert.equal(validateWorkspaceReceipt(request, identity,
    { result: { ...result, before: { ...fence, contentSha256: '7'.repeat(64) } }, files: [], blobs }, mask), null)
})

test('a revert apply receipt must match the confirmed preview and its Undo capture', () => {
  const previewVersion = gitRevertPreviewVersion({ operationId, revision, file, target: { kind: 'file' }, before: fence, after })
  const request: WorkspaceReadRequest = { kind: 'git_revert_apply', operationId, previewVersion, revision, file,
    target: { kind: 'file' }, expected: fence, after, contentBase64: base.toString('base64') }
  const result: WorkspaceReadReceipt['result'] = { ok: true, identity, observedAt, availability: 'online', kind: 'git_revert_applied',
    operationId, previewVersion, appliedAt: observedAt, headSha, idempotent: false,
    after: { headSha, path: file.path, exists: true, mode: '100644', size: base.length,
      contentSha256: digest(base), workingVersion: '6'.repeat(64) } }
  const undo = { files: [{ path: file.path, existed: true, mode: '100644',
    base64: before.toString('base64'), sha256: digest(before), after: { exists: true, contentSha256: digest(base) } }] }
  const applied = validateWorkspaceReceipt(request, identity, { result, files: [] }, mask)
  assert.equal(applied?.ok, true)
  if (!applied || !applied.ok || applied.kind !== 'git_revert_applied' || !('undoAvailable' in applied)) throw new Error('apply_missing')
  assert.equal(applied.undoAvailable, false)
  assert.deepEqual(applied.file, { path: file.path, action: 'restored', contentSha256: digest(base), workingVersion: '6'.repeat(64) })
  const withUndo = validateWorkspaceReceipt(request, identity, { result, files: [], gitUndo: undo } as WorkspaceReadReceipt, mask)
  assert.equal(withUndo?.ok === true && withUndo.kind === 'git_revert_applied'
    && 'undoAvailable' in withUndo && withUndo.undoAvailable, true)
  // A receipt that answers a different commitment cannot become the applied result.
  assert.equal(validateWorkspaceReceipt(request, identity,
    { result: { ...result, previewVersion: '5'.repeat(64) }, files: [] }, mask), null)
  // An Undo capture that disagrees with the confirmed pre-state is refused.
  assert.equal(validateWorkspaceReceipt(request, identity,
    { result, files: [], gitUndo: { files: [{ ...undo.files[0]!, sha256: '4'.repeat(64) }] } } as WorkspaceReadReceipt, mask), null)
})
