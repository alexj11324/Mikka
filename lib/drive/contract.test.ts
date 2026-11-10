import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import {
  DRIVE_MAX_ENTRIES, DRIVE_MAX_FILE_BYTES, DRIVE_MAX_CHANGES, DRIVE_SCOPES,
  applyDriveChanges, conflictedDrivePaths, driveChangePaths, driveManifestProblem, drivePathProblem,
  driveScopeProblem, driveWriteProblem, isDrivePath, isDriveScope, isVolumeId, isVolumeVersionId,
  manifestCanonicalText, manifestDigest,
  type DriveChange, type DriveManifestEntry,
} from './contract.ts'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const hex = (character: string) => character.repeat(64)
const entry = (path: string, over: Partial<DriveManifestEntry> = {}): DriveManifestEntry =>
  ({ path, mode: 0o644, sizeBytes: 3, sha256: hex('a'), ...over })

test('ids are prefixed ULIDs, so a volume id cannot be mistaken for a uuid', () => {
  assert.equal(isVolumeId('vol_01ARZ3NDEKTSV4RRFFQ69G5FAV'), true)
  assert.equal(isVolumeVersionId('vver_01ARZ3NDEKTSV4RRFFQ69G5FAV'), true)
  assert.equal(isVolumeId('01ARZ3NDEKTSV4RRFFQ69G5FAV'), false, 'a bare ULID is not enough')
  assert.equal(isVolumeId('vol_01ARZ3NDEKTSV4RRFFQ69G5FA'), false, '25 characters is short')
  assert.equal(isVolumeId('vol_01ARZ3NDEKTSV4RRFFQ69G5FAVU'), false, '27 characters is long')
  // I, L, O and U are excluded from Crockford base32 so they cannot be misread as 1/0.
  assert.equal(isVolumeId('vol_01ARZ3NDEKTSV4RRFFQ69G5FAI'), false)
  assert.equal(isVolumeId('vol_01ARZ3NDEKTSV4RRFFQ69G5FAU'), false)
  // The prefixes are distinct: a version id is never accepted where a volume id is required.
  assert.equal(isVolumeId('vver_01ARZ3NDEKTSV4RRFFQ69G5FAV'), false)
  assert.equal(isVolumeVersionId('vol_01ARZ3NDEKTSV4RRFFQ69G5FAV'), false)
  assert.equal(isVolumeId(`vol_${'0'.repeat(26)}`), true)
  assert.equal(isVolumeId('vol_' + '0'.repeat(25) + '\n'), false)
  assert.equal(isVolumeId(undefined), false)
})

test('a Drive path is relative, POSIX, and has no segment a host would reinterpret', () => {
  for (const good of ['README.md', 'notes/2026/a.md', 'a.b/c', '.gitignore', 'spaces are fine/a b.txt'])
    assert.equal(isDrivePath(good), true, good)
  for (const bad of ['', '/etc/passwd', '../escape', 'a/../b', 'a/./b', 'a//b', 'a\\b', 'C:/x', 'c:x', 'a\u0000b', 'a\nb', 'a\u007fb'])
    assert.equal(isDrivePath(bad), false, JSON.stringify(bad))
  assert.equal(isDrivePath('a'.repeat(1025)), false, 'over the byte budget')
  assert.equal(drivePathProblem('/abs'), 'not_relative')
  assert.equal(drivePathProblem('a\\b'), 'forbidden_character')
  assert.equal(drivePathProblem('a//b'), 'bad_segment')
  assert.equal(drivePathProblem('a'.repeat(1025)), 'too_long')
  assert.equal(drivePathProblem('ok/ok'), null)
})

test('the manifest digest is a property of the tree, not of listing order', () => {
  const a = entry('a.txt', { sha256: hex('1') }), b = entry('b/c.txt', { sha256: hex('2'), mode: 0o755 })
  assert.equal(manifestDigest([a, b], sha), manifestDigest([b, a], sha))
  assert.match(manifestDigest([a], sha), /^[a-f0-9]{64}$/)
  // Content, mode, size and path each change the digest.
  const base = manifestDigest([a], sha)
  assert.notEqual(manifestDigest([{ ...a, sha256: hex('9') }], sha), base)
  assert.notEqual(manifestDigest([{ ...a, mode: 0o755 }], sha), base)
  assert.notEqual(manifestDigest([{ ...a, sizeBytes: 4 }], sha), base)
  assert.notEqual(manifestDigest([{ ...a, path: 'b.txt' }], sha), base)
  // NUL separators keep a boundary from merging two different trees.
  assert.notEqual(manifestDigest([entry('a/b'), entry('c')], sha), manifestDigest([entry('a'), entry('b/c')], sha))
  // Sorted by path, one line per entry: path NUL mode NUL size NUL sha256 LF.
  assert.equal(manifestCanonicalText([b, a]), `a.txt\u0000420\u00003\u0000${hex('1')}\nb/c.txt\u0000493\u00003\u0000${hex('2')}\n`)
  assert.deepEqual(manifestCanonicalText([]), '')
})

test('the three upper bounds are enforced, and a mode is one of exactly two values', () => {
  assert.equal(driveManifestProblem([]), null)
  assert.equal(driveManifestProblem([entry('a'), entry('b', { mode: 0o755 })]), null)
  // entryCount 100 000 is inclusive: a tree exactly at the limit is accepted.
  assert.equal(driveManifestProblem(Array.from({ length: 3 }, (_, i) => entry(`f${i}`))), null)
  assert.equal(DRIVE_MAX_ENTRIES, 100_000)
  assert.equal(DRIVE_MAX_FILE_BYTES, 100 * 1024 * 1024)
  assert.equal(driveManifestProblem([entry('a'), entry('a')]), 'path_duplicate')
  assert.equal(driveManifestProblem([entry('a', { mode: 0o600 as never })]), 'mode_invalid')
  assert.equal(driveManifestProblem([entry('a', { mode: 0o777 as never })]), 'mode_invalid')
  assert.equal(driveManifestProblem([entry('a', { sizeBytes: -1 })]), 'size_invalid')
  assert.equal(driveManifestProblem([entry('a', { sizeBytes: 1.5 })]), 'size_invalid')
  assert.equal(driveManifestProblem([entry('a', { sizeBytes: DRIVE_MAX_FILE_BYTES + 1 })]), 'file_too_large')
  assert.equal(driveManifestProblem([entry('a', { sizeBytes: DRIVE_MAX_FILE_BYTES })]), null, 'exactly 100 MiB is allowed')
  assert.equal(driveManifestProblem([entry('a', { sha256: 'nope' })]), 'digest_invalid')
  assert.equal(driveManifestProblem([entry('../a')]), 'path_invalid')
})

test('a write must be a non-empty, deduplicated change set with an idempotency key', () => {
  const write = (over: Partial<{ expectedDigest: string | null; changes: DriveChange[]; mutationId: string }> = {}) =>
    ({ expectedDigest: null, changes: [{ op: 'put' as const, path: 'a', mode: 0o644 as const, sha256: hex('a'), sizeBytes: 1 }], mutationId: 'mut_0123456789', ...over })
  assert.equal(driveWriteProblem(write()), null)
  assert.equal(driveWriteProblem(write({ mutationId: 'short' })), 'mutation_id_invalid')
  assert.equal(driveWriteProblem(write({ changes: [] })), 'no_changes')
  assert.equal(driveWriteProblem(write({ changes: [{ op: 'delete', path: 'a' }, { op: 'delete', path: 'a' }] })), 'path_duplicate')
  assert.equal(driveWriteProblem(write({ changes: [{ op: 'delete', path: '/a' }] })), 'path_invalid')
  assert.equal(driveWriteProblem(write({ changes: [{ op: 'put', path: 'a', mode: 0o600 as never, sha256: hex('a'), sizeBytes: 1 }] })), 'mode_invalid')
  assert.equal(driveWriteProblem(write({ changes: [{ op: 'put', path: 'a', mode: 0o644, sha256: hex('a'), sizeBytes: DRIVE_MAX_FILE_BYTES + 1 }] })), 'file_too_large')
  assert.equal(DRIVE_MAX_CHANGES, 10_000)
  assert.equal(driveWriteProblem(write({ changes: Array.from({ length: DRIVE_MAX_CHANGES + 1 }, (_, i) => ({ op: 'delete' as const, path: `f${i}` })) })), 'too_many_changes')
})

test('applying changes never trusts a client size: the stored blob is the authority', () => {
  const current = [entry('keep.txt', { sha256: hex('1') }), entry('gone.txt', { sha256: hex('2') })]
  const sizes = new Map([[hex('a'), 5], [hex('b'), 9]])
  const change: DriveChange = { op: 'put', path: 'new.txt', mode: 0o755, sha256: hex('a'), sizeBytes: 5 }
  const applied = applyDriveChanges(current, [change, { op: 'delete', path: 'gone.txt' }], s => sizes.get(s))
  assert.ok('manifest' in applied)
  assert.deepEqual(applied.manifest.map(e => e.path), ['keep.txt', 'new.txt'])
  assert.equal(applied.manifest[1]!.sizeBytes, 5)
  assert.equal(applied.manifest[1]!.mode, 0o755)

  // A blob the store never received, and a size that disagrees with the bytes, are both refused.
  assert.deepEqual(applyDriveChanges(current, [{ ...change, sha256: hex('f') }], s => sizes.get(s)),
    { problem: 'blob_unknown', path: 'new.txt' })
  assert.deepEqual(applyDriveChanges(current, [{ ...change, sizeBytes: 6 }], s => sizes.get(s)),
    { problem: 'blob_size_mismatch', path: 'new.txt' })
  // A delete of a path that is absent is a no-op, not a failure: the tree is already what the client wants.
  // The result is path-sorted, so it is comparable by digest to any other listing of the same tree.
  const unchanged = applyDriveChanges(current, [{ op: 'delete', path: 'absent' }], s => sizes.get(s))
  assert.ok('manifest' in unchanged)
  assert.deepEqual(unchanged.manifest.map(e => e.path), ['gone.txt', 'keep.txt'])
  assert.equal(manifestDigest(unchanged.manifest, sha), manifestDigest(current, sha))
})

test('a conflict names the paths to re-read, and only the ones that really differ', () => {
  const current = [entry('same.txt', { sha256: hex('1') }), entry('theirs.txt', { sha256: hex('2') }), entry('deleted.txt', { sha256: hex('3') })]
  const changes: DriveChange[] = [
    { op: 'put', path: 'same.txt', mode: 0o644, sha256: hex('1'), sizeBytes: 3 },   // already matches: no conflict
    { op: 'put', path: 'theirs.txt', mode: 0o644, sha256: hex('9'), sizeBytes: 3 }, // they changed it: conflict
    { op: 'put', path: 'mine.txt', mode: 0o644, sha256: hex('9'), sizeBytes: 3 },   // only we have it: fine, no conflict
    { op: 'delete', path: 'deleted.txt' },                                          // still there: conflict
    { op: 'delete', path: 'absent.txt' },                                           // already absent: no conflict
  ]
  assert.deepEqual(conflictedDrivePaths(current, changes), ['deleted.txt', 'theirs.txt'])
  assert.deepEqual(driveChangePaths(changes), ['absent.txt', 'deleted.txt', 'mine.txt', 'same.txt', 'theirs.txt'])
  // A mode-only change on an otherwise identical blob is still a difference worth reporting.
  assert.deepEqual(conflictedDrivePaths(current, [{ op: 'put', path: 'same.txt', mode: 0o755, sha256: hex('1'), sizeBytes: 3 }]), ['same.txt'])
})

test('the three Drive scopes are distinct from the tenant, and project-user names both', () => {
  assert.deepEqual([...DRIVE_SCOPES], ['user', 'project', 'project-user'])
  // `workspace` is the tenant everywhere else in this codebase; a volume's
  // scope is a layer of Drive, so the word must not appear here.
  assert.equal((DRIVE_SCOPES as readonly string[]).includes('workspace'), false)
  assert.equal(isDriveScope('user'), true)
  assert.equal(isDriveScope('workspace'), false)
  assert.equal(isDriveScope('org'), false)
  // A person's own volume names one subject and no user.
  assert.equal(driveScopeProblem('user', 'user_1', null), null)
  assert.equal(driveScopeProblem('user', 'user_1', 'user_1'), 'scope_user_unexpected')
  // A project volume names the project only.
  assert.equal(driveScopeProblem('project', 'proj_1', null), null)
  assert.equal(driveScopeProblem('project', 'proj_1', 'user_1'), 'scope_user_unexpected')
  // A project-user volume names both, and needs the person.
  assert.equal(driveScopeProblem('project-user', 'proj_1', 'user_1'), null)
  assert.equal(driveScopeProblem('project-user', 'proj_1', null), 'scope_user_required')
  assert.equal(driveScopeProblem('project-user', 'proj_1', ''), 'scope_user_required')
  assert.equal(driveScopeProblem('workspace', 'ws_1', null), 'scope_invalid')
  assert.equal(driveScopeProblem('user', '', null), 'scope_id_empty')
  assert.equal(driveScopeProblem('user', undefined, null), 'scope_id_empty')
})
