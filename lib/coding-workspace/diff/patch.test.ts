import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSecretMasker, identityMasker, withCredentialMasking } from '../../secrets/mask'
import { buildDiffFilePatch, diffFileVersion, gitBlobHash, validateReviewAnchor } from './patch'
import type { DiffFileMetadata } from '@mikka/protocol/coding-workspace-review'

const objectId = (bytes: Buffer | null) => bytes === null ? null : createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
function input(before: string | Buffer | null, after: string | Buffer | null, changes: Partial<DiffFileMetadata> = {}) {
  const left = before === null ? null : Buffer.from(before), right = after === null ? null : Buffer.from(after)
  const file = { path: 'source.ts', previousPath: null, status: before === null ? 'added' as const : after === null ? 'deleted' as const : 'modified' as const,
    oldBlob: objectId(left), newBlob: objectId(right), oldMode: left ? '100644' : null, newMode: right ? '100644' : null,
    additions: 0, deletions: 0, binary: false, fileVersion: 'f'.repeat(64), ...changes }
  return { snapshotId: randomUUID(), sourceVersion: 'e'.repeat(64), file, before: left, after: right }
}

test('hash-verified patches apply through real Git and preserve CRLF, Unicode and missing final newline', t => {
  const root = mkdtempSync(join(tmpdir(), 'mikka-review-patch-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', root])
  const path = 'code 空间.ts', before = 'one\r\n二\r\nlast', after = 'one\r\n三\r\nlast'
  writeFileSync(join(root, path), before)
  const fixture = input(before, after, { path })
  const result = buildDiffFilePatch(fixture, identityMasker)
  assert.equal(result.format, 'text')
  assert.equal(result.file.additions, 1); assert.equal(result.file.deletions, 1)
  execFileSync('git', ['apply', '--check', '-'], { cwd: root, input: result.patch! })
  execFileSync('git', ['apply', '-'], { cwd: root, input: result.patch! })
  assert.equal(readFileSync(join(root, path), 'utf8'), after)
  assert.equal(execFileSync('git', ['hash-object', '--stdin'], { input: fixture.after!, encoding: 'utf8' }).trim(),
    gitBlobHash(fixture.after!, fixture.file.newBlob!))
})

test('additions and deletions expose only lines actually present on their chosen side', () => {
  for (const [before, after, side, denied] of [[null, 'new\n', 'RIGHT', 'LEFT'], ['old\n', null, 'LEFT', 'RIGHT']] as const) {
    const patch = buildDiffFilePatch(input(before, after), identityMasker)
    const anchor = { snapshotId: patch.snapshotId, sourceVersion: patch.sourceVersion, path: patch.file.path,
      side, lineStart: 1, lineEnd: 1, hunkFingerprint: patch.hunks[0]!.fingerprint }
    assert.deepEqual(validateReviewAnchor(anchor, patch), anchor)
    assert.throws(() => validateReviewAnchor({ ...anchor, side: denied }, patch), /workspace_review_anchor_invalid/)
  }
})

test('anchors cannot cross hunk gaps or substitute snapshot, source, path, fingerprint or side range', () => {
  const before = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n')
  const after = before.replace('line 2\n', 'changed 2\n').replace('line 39\n', 'changed 39\n')
  const patch = buildDiffFilePatch(input(before, after), identityMasker)
  assert.equal(patch.hunks.length, 2)
  const anchor = { snapshotId: patch.snapshotId, sourceVersion: patch.sourceVersion, path: patch.file.path,
    side: 'RIGHT', lineStart: 2, lineEnd: 2, hunkFingerprint: patch.hunks[0]!.fingerprint }
  assert.doesNotThrow(() => validateReviewAnchor(anchor, patch))
  for (const change of [{ snapshotId: randomUUID() }, { sourceVersion: 'a'.repeat(64) }, { path: 'other.ts' },
    { hunkFingerprint: patch.hunks[1]!.fingerprint }, { lineEnd: 20 }, { lineStart: 0 }, { previousPath: 'old.ts' }]) {
    assert.throws(() => validateReviewAnchor({ ...anchor, ...change }, patch), /workspace_review_anchor_invalid/)
  }
  const forged = structuredClone(patch); forged.hunks[0]!.lines[0] = '+forged'
  assert.throws(() => validateReviewAnchor(anchor, forged), /workspace_review_anchor_invalid/)
})

test('rename anchors must retain the original path and cannot silently reanchor', () => {
  const patch = buildDiffFilePatch(input('old\n', 'new\n', { path: 'new.ts', previousPath: 'old.ts', status: 'renamed' }), identityMasker)
  const anchor = { snapshotId: patch.snapshotId, sourceVersion: patch.sourceVersion, path: 'new.ts', previousPath: 'old.ts',
    side: 'RIGHT', lineStart: 1, lineEnd: 1, hunkFingerprint: patch.hunks[0]!.fingerprint }
  assert.doesNotThrow(() => validateReviewAnchor(anchor, patch))
  assert.throws(() => validateReviewAnchor({ ...anchor, previousPath: 'other.ts' }, patch), /workspace_review_anchor_invalid/)
})

test('full blob proof rejects mismatch, omitted side and unexpected bytes for a missing side', () => {
  const fixture = input('old\n', 'new\n')
  assert.throws(() => buildDiffFilePatch({ ...fixture, after: Buffer.from('forged\n') }, identityMasker), /workspace_snapshot_unavailable/)
  assert.throws(() => buildDiffFilePatch({ ...fixture, before: null }, identityMasker), /workspace_snapshot_unavailable/)
  const added = input(null, 'new\n')
  assert.throws(() => buildDiffFilePatch({ ...added, before: Buffer.alloc(0) }, identityMasker), /workspace_snapshot_unavailable/)
})

test('a multiline registered secret outside a changed hunk blocks the complete file', () => {
  const secret = 'multiline-private-first\nmultiline-private-second'
  const prefix = secret + '\n' + 'ordinary\n'.repeat(30)
  const mask = withCredentialMasking(createSecretMasker([{ name: 'PRIVATE', value: secret }]))
  assert.throws(() => buildDiffFilePatch(input(prefix + 'old\n', prefix + 'new\n'), mask), /workspace_path_unavailable/)
  assert.throws(() => buildDiffFilePatch(input('old\n', secret + '\n'), mask), /workspace_path_unavailable/)
  assert.throws(() => buildDiffFilePatch(input(secret + '\n', null), mask), /workspace_path_unavailable/)
  assert.throws(() => buildDiffFilePatch(input('old\n', 'ghp_012345678901234567890123456789\n'), mask), /workspace_path_unavailable/)
})

test('binary, invalid UTF-8, symlink and oversized files return metadata without content', () => {
  for (const value of [Buffer.from([0, 1, 2]), Buffer.from([0xff, 0xfe])]) {
    const result = buildDiffFilePatch(input(null, value), identityMasker)
    assert.equal(result.format, 'binary'); assert.equal(result.patch, null); assert.deepEqual(result.hunks, [])
  }
  const symlink = buildDiffFilePatch(input('old\n', '../HOME/key', { newMode: '120000' }), identityMasker)
  assert.equal(symlink.format, 'unavailable'); assert.equal(symlink.patch, null)
  const large = buildDiffFilePatch(input(null, Buffer.alloc(1024 * 1024 + 1, 'x')), identityMasker)
  assert.equal(large.format, 'too_large'); assert.equal(large.patch, null)
})

test('Reviewed keys depend on this file, both revisions, paths and modes, not another file in the snapshot', () => {
  const file = input('old\n', 'new\n').file
  const revision = { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) }
  const version = diffFileVersion('repository', revision, file)
  assert.equal(diffFileVersion('repository', { ...revision }, { ...file }), version)
  for (const change of [{ newBlob: 'c'.repeat(40) }, { oldBlob: 'd'.repeat(40) }, { path: 'renamed.ts' }, { newMode: '100755' }]) {
    assert.notEqual(diffFileVersion('repository', revision, { ...file, ...change }), version)
  }
  assert.notEqual(diffFileVersion('repository', { ...revision, headSha: 'c'.repeat(40) }, file), version)
  assert.notEqual(diffFileVersion('other-repository', revision, file), version)
})
