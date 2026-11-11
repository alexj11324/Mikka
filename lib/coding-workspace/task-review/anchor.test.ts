import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import {
  taskReviewLineComment, taskReviewRef, taskReviewSubmission, WorkspaceReviewError,
  type DiffFileMetadata, type DiffFilePatch,
} from '@mikka/protocol/coding-workspace-review'
import { identityMasker } from '../../secrets/mask'
import { buildDiffFilePatch, diffFileVersion, validateReviewAnchor } from '../diff/patch'
import { manifestRevision } from '../diff/store'
import { taskCommentAnchor } from './anchor'

const repoId = randomUUID()
const objectHash = (type: string, bytes: Buffer) => createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex')

// Complete Git objects give the fixture a real commit and blob identity. Two
// working observations of the same before image deliberately keep this HEAD.
function commitFor(path: string, bytes: Buffer | null) {
  const tree = bytes === null ? Buffer.alloc(0) : Buffer.concat([
    Buffer.from(`100644 ${path}\0`), Buffer.from(objectHash('blob', bytes), 'hex'),
  ])
  return objectHash('commit', Buffer.from(`tree ${objectHash('tree', tree)}\nauthor Review Fixture <review@example.test> 1 +0000\ncommitter Review Fixture <review@example.test> 1 +0000\n\nReview fixture\n`))
}

function fixture(before: string | Buffer | null, after: string | Buffer | null, changes: Partial<DiffFileMetadata> = {}) {
  const left = before === null ? null : Buffer.from(before), right = after === null ? null : Buffer.from(after)
  const file: DiffFileMetadata = {
    path: 'source.ts', previousPath: null, status: left === null ? 'added' : right === null ? 'deleted' : 'modified',
    oldBlob: left === null ? null : objectHash('blob', left), newBlob: right === null ? null : objectHash('blob', right),
    oldMode: left === null ? null : '100644', newMode: right === null ? null : '100644',
    additions: 0, deletions: 0, binary: false, fileVersion: '', ...changes,
  }
  const headSha = commitFor(file.previousPath ?? file.path, left)
  file.fileVersion = diffFileVersion(repoId, { baseSha: headSha, headSha }, file)
  const revision = manifestRevision('working', headSha, headSha, null, [file])
  const input = { snapshotId: randomUUID(), sourceVersion: revision.version, file, before: left, after: right }
  return { input, revision, patch: buildDiffFilePatch(input, identityMasker) }
}

const comment = (line: number, side: 'old' | 'new' = 'new', path = 'source.ts') => ({ path, line, side, body: 'Please review this line.' })
const reference = (patch: DiffFilePatch) => ({ snapshotId: patch.snapshotId, sourceVersion: patch.sourceVersion })
const anchorError = (error: unknown) => error instanceof WorkspaceReviewError && error.code === 'workspace_review_anchor_invalid'

test('task comments bind old, new and context lines to the complete verified patch', async t => {
  const { patch } = fixture('first\nold value\nshared\n', 'first\nnew value\nshared\n')
  assert.equal(patch.format, 'text')
  assert.equal(patch.hunks.length, 1)
  for (const [name, line, side, expected] of [
    ['removed line', 2, 'old', 'LEFT'], ['added line', 2, 'new', 'RIGHT'],
    ['first old context', 1, 'old', 'LEFT'], ['first new context', 1, 'new', 'RIGHT'],
    ['last old context', 3, 'old', 'LEFT'], ['last new context', 3, 'new', 'RIGHT'],
  ] as const) await t.test(name, () => {
    const anchor = taskCommentAnchor(patch, comment(line, side))
    assert.deepEqual(anchor, { ...reference(patch), path: 'source.ts', side: expected,
      lineStart: line, lineEnd: line, hunkFingerprint: patch.hunks[0]!.fingerprint })
    assert.deepEqual(validateReviewAnchor(anchor, patch), anchor)
  })
})

test('rename anchors retain the old path but accept only the selected new file path', () => {
  const { patch } = fixture('old name\n', 'new name\n', { path: 'new name.ts', previousPath: 'old name.ts', status: 'renamed' })
  for (const side of ['old', 'new'] as const) {
    const anchor = taskCommentAnchor(patch, comment(1, side, 'new name.ts'))
    assert.equal(anchor.path, 'new name.ts')
    assert.equal(anchor.previousPath, 'old name.ts')
    assert.deepEqual(validateReviewAnchor(anchor, patch), anchor)
    assert.throws(() => taskCommentAnchor(patch, comment(1, side, 'old name.ts')), anchorError)
  }
  assert.throws(() => taskCommentAnchor(patch, comment(1, 'new', 'unrelated.ts')), anchorError)
})

test('added and deleted files never manufacture a line on the absent side', async t => {
  await t.test('added file', () => {
    const { patch } = fixture(null, 'one\ntwo\nthree\n')
    for (const line of [1, 3]) assert.equal(taskCommentAnchor(patch, comment(line)).side, 'RIGHT')
    assert.throws(() => taskCommentAnchor(patch, comment(1, 'old')), anchorError)
    assert.throws(() => taskCommentAnchor(patch, comment(4)), anchorError)
  })
  await t.test('deleted file', () => {
    const { patch } = fixture('one\ntwo\nthree\n', null)
    for (const line of [1, 3]) assert.equal(taskCommentAnchor(patch, comment(line, 'old')).side, 'LEFT')
    assert.throws(() => taskCommentAnchor(patch, comment(1)), anchorError)
    assert.throws(() => taskCommentAnchor(patch, comment(4, 'old')), anchorError)
  })
})

test('a real file line between separated hunks is not a reviewable diff line', () => {
  const before = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`)
  const after = [...before]
  after[2] = 'changed line 3'; after[34] = 'changed line 35'
  const { patch } = fixture(before.join('\n') + '\n', after.join('\n') + '\n')
  assert.equal(patch.hunks.length, 2)
  for (const side of ['old', 'new'] as const) {
    assert.equal(taskCommentAnchor(patch, comment(3, side)).lineStart, 3)
    assert.equal(taskCommentAnchor(patch, comment(35, side)).lineStart, 35)
    assert.throws(() => taskCommentAnchor(patch, comment(20, side)), anchorError)
  }
})

test('overlapping hunk candidates are rejected instead of selecting the first match', () => {
  const { patch } = fixture('old\n', 'new\n')
  const ambiguous = { ...patch, hunks: [...patch.hunks, structuredClone(patch.hunks[0]!)] }
  for (const side of ['old', 'new'] as const)
    assert.throws(() => taskCommentAnchor(ambiguous, comment(1, side)), anchorError)
})

test('missing final newline markers do not create an extra source line', () => {
  const { patch } = fixture('first\nold', 'first\nnew')
  assert.ok(patch.hunks[0]!.lines.some(line => line.startsWith('\\ No newline')))
  for (const side of ['old', 'new'] as const) {
    assert.equal(taskCommentAnchor(patch, comment(2, side)).lineEnd, 2)
    assert.throws(() => taskCommentAnchor(patch, comment(3, side)), anchorError)
  }
})

test('binary, unavailable and missing patches cannot produce task anchors', async t => {
  for (const [name, patch] of [
    ['binary', fixture(Buffer.from([0, 1]), Buffer.from([0, 2])).patch],
    ['unavailable', fixture('old\n', 'new\n', { newMode: '120000' }).patch],
    ['missing patch', { ...fixture('old\n', 'new\n').patch, patch: null }],
    ['empty patch', { ...fixture('old\n', 'new\n').patch, patch: '' }],
  ] as const) await t.test(name, () => {
    if (name === 'binary' || name === 'unavailable') assert.equal(patch.format, name)
    assert.throws(() => taskCommentAnchor(patch, comment(1)), anchorError)
  })
})

test('line coordinates must be positive bounded integers and must exist in the patch', async t => {
  const { patch } = fixture('old\n', 'new\n')
  for (const [name, line] of [
    ['zero', 0], ['negative', -1], ['fraction', 1.5], ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY], ['over the bound', 1_000_001], ['string', '1'], ['missing', undefined],
  ] as const) await t.test(name, () => {
    const raw = { ...comment(1), line }
    assert.equal(taskReviewLineComment.safeParse(raw).success, false)
    assert.throws(() => taskCommentAnchor(patch, raw))
  })
  assert.equal(taskReviewLineComment.safeParse(comment(1_000_000)).success, true)
  assert.throws(() => taskCommentAnchor(patch, comment(1_000_000)), anchorError)
})

test('same HEAD and line numbers do not let an old anchor move to new working bytes', () => {
  const old = fixture('const value = 0;\n', 'const value = 1;\n')
  const next = fixture('const value = 0;\n', 'const value = 2;\n')
  assert.equal(old.revision.headSha, next.revision.headSha)
  assert.equal(old.revision.baseSha, next.revision.baseSha)
  assert.notEqual(old.patch.file.newBlob, next.patch.file.newBlob)
  assert.notEqual(old.patch.file.fileVersion, next.patch.file.fileVersion)
  assert.notEqual(old.patch.sourceVersion, next.patch.sourceVersion)
  assert.notDeepEqual(reference(old.patch), reference(next.patch))
  const anchor = taskCommentAnchor(old.patch, comment(1))
  const nextAnchor = taskCommentAnchor(next.patch, comment(1))
  assert.equal(anchor.sourceVersion, old.patch.sourceVersion)
  assert.equal(nextAnchor.sourceVersion, next.patch.sourceVersion)
  assert.notEqual(anchor.hunkFingerprint, nextAnchor.hunkFingerprint)
  assert.throws(() => validateReviewAnchor(anchor, next.patch), anchorError)
  assert.throws(() => validateReviewAnchor({ ...anchor, snapshotId: next.patch.snapshotId }, next.patch), anchorError)
  assert.throws(() => validateReviewAnchor({ ...anchor, ...reference(next.patch) }, next.patch), anchorError)
})

test('identical source bytes in a different snapshot still cannot reuse an old snapshot anchor', () => {
  const first = fixture('old\n', 'new\n'), second = fixture('old\n', 'new\n')
  assert.equal(first.patch.sourceVersion, second.patch.sourceVersion)
  assert.notEqual(first.patch.snapshotId, second.patch.snapshotId)
  assert.throws(() => validateReviewAnchor(taskCommentAnchor(first.patch, comment(1)), second.patch), anchorError)
})

test('complete blob proof and hunk fingerprints reject altered source before an anchor can be used', () => {
  const { input, patch } = fixture('old\n', 'new\n')
  assert.throws(() => buildDiffFilePatch({ ...input, after: Buffer.from('different\n') }, identityMasker),
    error => error instanceof WorkspaceReviewError && error.code === 'workspace_snapshot_unavailable')
  const changed = structuredClone(patch)
  changed.hunks[0]!.lines = changed.hunks[0]!.lines.map(line => line === '+new' ? '+different' : line)
  assert.throws(() => taskCommentAnchor(changed, comment(1)), anchorError)
})

test('task submissions require the captured reference and reject legacy or malformed version claims', async t => {
  const { patch } = fixture('old\n', 'new\n')
  const reviewRef = reference(patch)
  const valid = { reviewRef, comments: [comment(1)], attachedChecks: [], idempotencyKey: 'frozen-batch' }
  assert.deepEqual(taskReviewSubmission.parse(valid), valid)
  assert.deepEqual(taskReviewRef.parse(reviewRef), reviewRef)
  const { reviewRef: omitted, ...legacy } = valid
  assert.equal(omitted, reviewRef)
  assert.equal(taskReviewSubmission.safeParse(legacy).success, false)
  for (const [name, invalid] of [
    ['null reference', null], ['HEAD is not a source version', { ...reviewRef, sourceVersion: 'a'.repeat(40) }],
    ['truncated digest', { ...reviewRef, sourceVersion: patch.sourceVersion.slice(1) }],
    ['nonhex digest', { ...reviewRef, sourceVersion: 'x'.repeat(64) }],
    ['not a snapshot id', { ...reviewRef, snapshotId: 'current' }],
    ['missing source version', { snapshotId: reviewRef.snapshotId }],
    ['replacement HEAD field', { ...reviewRef, headSha: 'a'.repeat(40) }],
  ] as const) await t.test(name, () => {
    assert.equal(taskReviewRef.safeParse(invalid).success, false)
    assert.equal(taskReviewSubmission.safeParse({ ...valid, reviewRef: invalid }).success, false)
  })
})

test('a comment cannot override the batch source or supply its own replacement hunk', () => {
  const first = fixture('old\n', 'new\n'), next = fixture('old\n', 'different\n')
  const valid = { reviewRef: reference(first.patch), comments: [comment(1)], attachedChecks: [], idempotencyKey: 'frozen-batch' }
  for (const injection of [{ reviewRef: reference(next.patch) }, { sourceVersion: next.patch.sourceVersion },
    { snapshotId: next.patch.snapshotId }, { hunkFingerprint: next.patch.hunks[0]!.fingerprint }]) {
    const raw = { ...comment(1), ...injection }
    assert.equal(taskReviewSubmission.safeParse({ ...valid, comments: [raw] }).success, false)
    assert.throws(() => taskCommentAnchor(first.patch, raw))
  }
  assert.equal(taskReviewSubmission.safeParse({ ...valid, reviewRef: [reference(first.patch), reference(next.patch)] }).success, false)
})
