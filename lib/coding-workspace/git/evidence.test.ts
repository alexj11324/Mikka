import assert from 'node:assert/strict'
import test from 'node:test'
import { structuredPatch } from 'diff'
import { gitRevertPreviewVersion, workspaceGitRevertApplyRequest, type GitRevertFile } from '@mikka/protocol/coding-workspace-git'
import type { DiffRevision } from '@mikka/protocol/coding-workspace-review'
import { gitBlobHash, hunkFingerprint } from '../diff/patch'
import type { Masker } from '../../secrets/mask'
import { gitDigest, inversePatch, revertHunks, revertedAfter, verifyRevertProofs } from './evidence'

const mask: Masker = Object.assign((value: string) => value, { sourcePolicy: 'd'.repeat(64) })
const object = (letter: string) => letter.repeat(40)
const baseSha = object('a'), headSha = object('b')
const revision: DiffRevision = { source: 'working', baseSha, headSha, treeSha: null, version: 'c'.repeat(64) }
const lines = (changeSecond: boolean, changeEighteenth: boolean) => Array.from({ length: 20 },
  (_, index) => index === 1 ? (changeSecond ? 'LINE02' : 'line02')
    : index === 17 ? (changeEighteenth ? 'LINE18' : 'line18') : `line${String(index + 1).padStart(2, '0')}`).join('\n') + '\n'
const base = Buffer.from(lines(false, false)), before = Buffer.from(lines(true, true))
const file: GitRevertFile = {
  path: 'src/a.ts', previousPath: null, status: 'modified',
  oldBlob: gitBlobHash(base, baseSha), newBlob: gitBlobHash(before, headSha),
  oldMode: '100644', newMode: '100644', oldSize: base.length, newSize: before.length,
  binary: false, fileVersion: 'f'.repeat(64),
}
const proofs = () => [
  { sha: file.oldBlob!, base64: base.toString('base64') },
  { sha: file.newBlob!, base64: before.toString('base64') },
]

test('complete base/current proofs are hash-verified before any revert content exists', () => {
  const verified = verifyRevertProofs(file, revision, proofs())
  assert.ok(verified)
  assert.deepEqual(verified.base, base)
  assert.deepEqual(verified.before, before)
  assert.equal(verifyRevertProofs(file, revision, [proofs()[0]!]), null)
  assert.equal(verifyRevertProofs(file, revision, [{ ...proofs()[0]!, base64: Buffer.from('tampered').toString('base64') }, proofs()[1]!]), null)
  assert.equal(verifyRevertProofs(file, revision, [...proofs(), proofs()[0]!]), null)
  assert.equal(verifyRevertProofs(file, revision, [proofs()[1]!, proofs()[0]!]), null)
})

test('a hunk revert replaces exactly the selected new-side ranges', () => {
  const computed = structuredPatch(file.path, file.path, base.toString(), before.toString(), undefined, undefined,
    { context: 3, stripTrailingCr: false, maxEditLength: 10_000, timeout: 100 })
  assert.equal(computed.hunks.length, 2)
  const first = hunkFingerprint(revision.version, file.fileVersion, computed.hunks[0]!)
  const reverted = revertHunks(file, revision.version, [first], before, base).toString()
  assert.equal(reverted, lines(false, true))
  assert.equal(revertedAfter(file, revision, { kind: 'hunks', fingerprints: [first] }, before, base).after.contentSha256,
    gitDigest(Buffer.from(reverted, 'utf8')))
  assert.throws(() => revertHunks(file, revision.version, ['0'.repeat(64)], before, base), /workspace_version_conflict/)
})

test('whole-file revert restores the base side and the inverse patch is the visible change', () => {
  const reverted = revertedAfter(file, revision, { kind: 'file' }, before, base)
  assert.deepEqual(reverted.bytes, base)
  assert.deepEqual(reverted.after, { exists: true, mode: '100644', contentSha256: gitDigest(base) })
  const inverse = inversePatch({ file, before, after: base, mask })
  assert.ok(inverse.patch?.includes('diff --git a/src/a.ts b/src/a.ts'))
  assert.ok(inverse.patch?.includes('-LINE02'))
  assert.ok(inverse.patch?.includes('+line02'))
  assert.ok(inverse.patch?.includes('-LINE18'))
  assert.equal(inverse.additions, 2)
  assert.equal(inverse.deletions, 2)
})

test('deleting an added file and restoring a deleted one keep null sides explicit', () => {
  const added: GitRevertFile = { ...file, status: 'added', oldBlob: null, oldMode: null, oldSize: null }
  const addedProofs = [{ sha: added.newBlob!, base64: before.toString('base64') }]
  const addedVerified = verifyRevertProofs(added, revision, addedProofs)
  assert.ok(addedVerified)
  assert.deepEqual(revertedAfter(added, revision, { kind: 'file' }, addedVerified.before, addedVerified.base).after,
    { exists: false, mode: null, contentSha256: null })
  const inverse = inversePatch({ file: added, before, after: null, mask })
  assert.ok(inverse.patch?.includes('deleted file mode 100644'))
  assert.ok(inverse.patch?.includes('+++ /dev/null'))
})

test('preview versions bind operation, revision, selected hunks and exact content', () => {
  const target = { kind: 'hunks' as const, fingerprints: ['1'.repeat(64), '2'.repeat(64)] }
  const beforeFence = { workingVersion: '3'.repeat(64), contentSha256: gitDigest(before), exists: true, mode: '100644' as const }
  const after = { exists: true, mode: '100644' as const, contentSha256: gitDigest(base) }
  const value = gitRevertPreviewVersion({ operationId: '00000000-0000-4000-8000-000000000000', revision, file, target, before: beforeFence, after })
  assert.match(value, /^[a-f0-9]{64}$/)
  assert.equal(value, gitRevertPreviewVersion({ operationId: '00000000-0000-4000-8000-000000000000', revision, file,
    target: { kind: 'hunks', fingerprints: [...target.fingerprints].reverse() }, before: beforeFence, after }))
  assert.notEqual(value, gitRevertPreviewVersion({ operationId: '00000000-0000-4000-8000-000000000001', revision, file, target, before: beforeFence, after }))
  assert.notEqual(value, gitRevertPreviewVersion({ operationId: '00000000-0000-4000-8000-000000000000', revision, file, target, before: beforeFence,
    after: { ...after, contentSha256: gitDigest(Buffer.from('different')) } }))
})

test('apply requests cannot claim a deletion with content or a restore with none', () => {
  const request = { kind: 'git_revert_apply', operationId: '00000000-0000-4000-8000-000000000000',
    previewVersion: 'c'.repeat(64), revision, file, target: { kind: 'file' },
    expected: { headSha, path: file.path, exists: true, mode: '100644', size: before.length,
      contentSha256: gitDigest(before), workingVersion: 'e'.repeat(64) },
    after: { exists: false, mode: null, contentSha256: null } }
  assert.ok(workspaceGitRevertApplyRequest.safeParse(request).success)
  assert.equal(workspaceGitRevertApplyRequest.safeParse({ ...request, contentBase64: before.toString('base64') }).success, false)
  assert.equal(workspaceGitRevertApplyRequest.safeParse({ ...request,
    after: { exists: true, mode: '100644', contentSha256: gitDigest(base) } }).success, false)
  assert.ok(workspaceGitRevertApplyRequest.safeParse({ ...request,
    after: { exists: true, mode: '100644', contentSha256: gitDigest(base) }, contentBase64: base.toString('base64') }).success)
})
