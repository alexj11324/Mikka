import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { createPatch } from 'diff'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import {
  WORKSPACE_DIFF_MAX_BLOB_BYTES, WorkspaceReviewError, diffFilePatch,
  type DiffFileMetadata, type DiffFilePatch,
} from '@mikka/protocol/coding-workspace-review'
import { createSecretMasker, identityMasker, withCredentialMasking } from '../../secrets/mask'
import { buildGitHubFilePatch } from './github-patch'
import { validateReviewAnchor } from './patch'

const objectId = (bytes: Buffer | null) => bytes === null ? null
  : createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')

/** GitHub's per-file patch contains the native hunks, without a diff file header. */
function nativePatch(before: string, after: string, context = 1) {
  const patch = createPatch('source.ts', before, after, undefined, undefined, { context, stripTrailingCr: false })
  const start = patch.indexOf('@@ ')
  assert.ok(start >= 0, 'the fixture must contain a real textual change')
  return patch.slice(start)
}

function fixture(before: string | Buffer | null, after: string | Buffer | null, patch: string | null,
  changes: Partial<DiffFileMetadata> = {}) {
  const left = before === null ? null : Buffer.from(before), right = after === null ? null : Buffer.from(after)
  const file: DiffFileMetadata = {
    path: 'source.ts', previousPath: null,
    status: left === null ? 'added' : right === null ? 'deleted' : 'modified',
    oldBlob: objectId(left), newBlob: objectId(right), oldMode: left === null ? null : '100644',
    newMode: right === null ? null : '100644', oldSize: left?.length ?? null, newSize: right?.length ?? null,
    additions: 0, deletions: 0, binary: false, fileVersion: 'f'.repeat(64), ...changes,
  }
  return { snapshotId: randomUUID(), sourceVersion: 'e'.repeat(64), file,
    before: left, after: right, nativePatch: patch }
}

function denied(action: () => unknown, message?: string) {
  assert.throws(action, error =>
    (error instanceof WorkspaceReviewError && error.code === 'workspace_snapshot_unavailable')
    || (error instanceof CodingWorkspaceError && error.code === 'workspace_path_unavailable'), message)
}

function nativePreserved(result: DiffFilePatch, patch: string) {
  assert.equal(result.format, 'text')
  assert.ok(result.patch?.includes(patch.replace(/\n$/, '')), 'native hunk headers and content must be preserved')
  assert.ok(diffFilePatch.safeParse(result).success, 'only the public patch DTO may be returned')
}

function anchor(patch: DiffFilePatch, hunk: number, side: 'LEFT' | 'RIGHT', line: number) {
  return { snapshotId: patch.snapshotId, sourceVersion: patch.sourceVersion, path: patch.file.path,
    ...(patch.file.previousPath === null ? {} : { previousPath: patch.file.previousPath }),
    side, lineStart: line, lineEnd: line, hunkFingerprint: patch.hunks[hunk]!.fingerprint }
}

test('the GitHub hunk range and original context survive instead of being replaced by a new diff', () => {
  const before = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n'
  const after = before.replace('five\n', 'changed\n')
  // A native zero-context hunk has a different range from the local three-context renderer.
  const patch = nativePatch(before, after, 0)
  assert.equal(patch, '@@ -5,1 +5,1 @@\n-five\n+changed\n')
  const result = buildGitHubFilePatch(fixture(before, after, patch), identityMasker)
  nativePreserved(result, patch)
  assert.equal(result.hunks.length, 1)
  const hunk = result.hunks[0]!
  assert.deepEqual([hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines], [5, 1, 5, 1])
  assert.deepEqual(hunk.lines, ['-five', '+changed'])
  assert.equal(result.file.additions, 1); assert.equal(result.file.deletions, 1)
  for (const side of ['LEFT', 'RIGHT'] as const) {
    assert.doesNotThrow(() => validateReviewAnchor(anchor(result, 0, side, 5), result))
    for (const line of [4, 6])
      assert.throws(() => validateReviewAnchor(anchor(result, 0, side, line), result), /workspace_review_anchor_invalid/)
  }
})

test('native cumulative insertions keep later LEFT and RIGHT anchors at their distinct source lines', () => {
  const lines = Array.from({ length: 26 }, (_, i) => `line ${i + 1}`)
  const next = [...lines]
  next.splice(2, 0, 'inserted one', 'inserted two'); next[21] = 'changed twenty'
  const before = lines.join('\n') + '\n', after = next.join('\n') + '\n'
  const patch = nativePatch(before, after)
  const result = buildGitHubFilePatch(fixture(before, after, patch), identityMasker)
  nativePreserved(result, patch)
  assert.equal(result.hunks.length, 2)
  assert.deepEqual(result.hunks.map(hunk => [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines]),
    [[2, 2, 2, 4], [19, 3, 21, 3]])
  assert.deepEqual(result.hunks[1]!.lines, [' line 19', '-line 20', '+changed twenty', ' line 21'])
  assert.doesNotThrow(() => validateReviewAnchor(anchor(result, 1, 'LEFT', 20), result))
  assert.doesNotThrow(() => validateReviewAnchor(anchor(result, 1, 'RIGHT', 22), result))
  assert.throws(() => validateReviewAnchor(anchor(result, 1, 'RIGHT', 20), result), /workspace_review_anchor_invalid/)
  assert.equal(result.file.additions, 3); assert.equal(result.file.deletions, 1)
})

test('zero-context insertions and deletions honor Git zero-length ranges at the start, middle and EOF', () => {
  for (const [before, after, side, line] of [
    ['one\ntwo\n', 'new\none\ntwo\n', 'RIGHT', 1],
    ['one\ntwo\n', 'one\nnew\ntwo\n', 'RIGHT', 2],
    ['one\ntwo\n', 'one\ntwo\nnew\n', 'RIGHT', 3],
    ['old\none\ntwo\n', 'one\ntwo\n', 'LEFT', 1],
    ['one\nold\ntwo\n', 'one\ntwo\n', 'LEFT', 2],
    ['one\ntwo\nold\n', 'one\ntwo\n', 'LEFT', 3],
  ] as const) {
    const patch = nativePatch(before, after, 0)
    const result = buildGitHubFilePatch(fixture(before, after, patch), identityMasker)
    nativePreserved(result, patch)
    assert.equal(result.hunks.length, 1)
    assert.equal(result.hunks[0]![side === 'RIGHT' ? 'oldLines' : 'newLines'], 0)
    assert.doesNotThrow(() => validateReviewAnchor(anchor(result, 0, side, line), result))
    const other = side === 'RIGHT' ? 'LEFT' : 'RIGHT'
    assert.throws(() => validateReviewAnchor(anchor(result, 0, other, line), result), /workspace_review_anchor_invalid/)
  }
})

test('repeated source lines do not authorize shifted coordinates or independently forged newStart', () => {
  const lines = Array.from({ length: 12 }, () => 'repeat')
  const next = [...lines]; next[8] = 'changed'
  const before = lines.join('\n') + '\n', after = next.join('\n') + '\n'
  const good = '@@ -9 +9 @@\n-repeat\n+changed\n'
  nativePreserved(buildGitHubFilePatch(fixture(before, after, good), identityMasker), good)
  for (const patch of [
    '@@ -3 +9 @@\n-repeat\n+changed\n', // Both individual side lines exist, but their unchanged prefixes cannot agree.
    '@@ -9 +3 @@\n-repeat\n+changed\n',
    '@@ -3 +3 @@\n-repeat\n+changed\n',
    '@@ -9 +10 @@\n-repeat\n+changed\n',
  ]) denied(() => buildGitHubFilePatch(fixture(before, after, patch), identityMasker))
})

test('omitting either complete hunk cannot hide changes in an unchecked prefix or suffix', () => {
  const before = Array.from({ length: 24 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  const after = before.replace('line 2\n', 'changed two\n').replace('line 23\n', 'changed twenty-three\n')
  const patch = nativePatch(before, after), second = patch.indexOf('\n@@ ') + 1
  assert.ok(second > 0)
  const firstHunk = patch.slice(0, second), lastHunk = patch.slice(second)
  const valid = buildGitHubFilePatch(fixture(before, after, patch), identityMasker)
  assert.equal(valid.hunks.length, 2)
  for (const incomplete of [firstHunk, lastHunk, lastHunk + firstHunk, firstHunk + patch])
    denied(() => buildGitHubFilePatch(fixture(before, after, incomplete), identityMasker))
})

test('malformed headers, bad counts, truncated bodies and extra non-hunk text are rejected', () => {
  const before = 'one\nold\nthree\n', after = 'one\nnew\nthree\n'
  const valid = '@@ -1,3 +1,3 @@\n one\n-old\n+new\n three\n'
  for (const patch of [
    valid.replace('-1,3', '-0,3'), valid.replace('+1,3', '+1,2'),
    valid.replace('-1,3', '-1,-3'), valid.replace('@@ -', '@ -'),
    valid.replace('+new\n', ''), valid.replace(' three\n', ''),
    valid.replace('+new\n', 'new\n'), valid.replace('-old\n', '-forged\n'),
    valid + 'trailing content\n', '@@ -1,3 +1,3 @@\n', 'not a patch', '',
  ]) denied(() => buildGitHubFilePatch(fixture(before, after, patch), identityMasker))
})

test('the patch transport may omit its final newline without changing source EOF semantics', () => {
  const before = 'old\n', after = 'new\n', patch = '@@ -1 +1 @@\n-old\n+new'
  const result = buildGitHubFilePatch(fixture(before, after, patch), identityMasker)
  nativePreserved(result, patch)
  assert.deepEqual(result.hunks[0]!.lines, ['-old', '+new'])
})

test('CRLF bytes, Unicode and BOM are preserved in the original hunk and checked against both full blobs', () => {
  const before = '\uFEFFheading\r\none\r\n二\r\nlast\r\n', after = before.replace('二\r\n', '三\r\n')
  const patch = nativePatch(before, after)
  const result = buildGitHubFilePatch(fixture(before, after, patch), identityMasker)
  nativePreserved(result, patch)
  assert.deepEqual(result.hunks[0]!.lines, [' one\r', '-二\r', '+三\r', ' last\r'])
  assert.deepEqual([result.hunks[0]!.oldStart, result.hunks[0]!.newStart], [2, 2])
  denied(() => buildGitHubFilePatch(fixture(before, after, patch.replace(/\r/g, '')), identityMasker),
    'a normalized LF patch cannot silently describe different CRLF proof bytes')
})

test('missing-final-newline markers bind the correct source side and do not create reviewable lines', () => {
  for (const [before, after] of [['old', 'new\n'], ['old\n', 'new'], ['old\nlast', 'new\nlast'],
    ['same\n', 'same'], ['same', 'same\n']] as const) {
    const patch = nativePatch(before, after)
    assert.ok(patch.includes('\\ No newline at end of file'))
    const result = buildGitHubFilePatch(fixture(before, after, patch), identityMasker)
    nativePreserved(result, patch)
    assert.doesNotThrow(() => validateReviewAnchor(anchor(result, 0, 'LEFT', 1), result))
    assert.doesNotThrow(() => validateReviewAnchor(anchor(result, 0, 'RIGHT', 1), result))
    const absentLine = Math.max(result.hunks[0]!.oldLines, result.hunks[0]!.newLines) + 1
    assert.throws(() => validateReviewAnchor(anchor(result, 0, 'RIGHT', absentLine), result), /workspace_review_anchor_invalid/)
    denied(() => buildGitHubFilePatch(fixture(before, after,
      patch.replace('\\ No newline at end of file\n', '')), identityMasker), 'source EOF information cannot be omitted')
  }
  const before = 'old\n', after = 'new\n'
  denied(() => buildGitHubFilePatch(fixture(before, after,
    '@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n'), identityMasker))
})

test('added and deleted files permit anchors only on the side that actually exists', () => {
  for (const [before, after, allowed, other] of [
    [null, 'new\n', 'RIGHT', 'LEFT'], ['old\n', null, 'LEFT', 'RIGHT'],
  ] as const) {
    const patch = nativePatch(before ?? '', after ?? '')
    const result = buildGitHubFilePatch(fixture(before, after, patch), identityMasker)
    nativePreserved(result, patch)
    assert.doesNotThrow(() => validateReviewAnchor(anchor(result, 0, allowed, 1), result))
    assert.throws(() => validateReviewAnchor(anchor(result, 0, other, 1), result), /workspace_review_anchor_invalid/)
    assert.equal(result.hunks[0]![allowed === 'RIGHT' ? 'oldLines' : 'newLines'], 0)
  }
})

test('renamed file anchors preserve previousPath and use the native file positions', () => {
  const before = 'unchanged\nold\n', after = 'unchanged\nnew\n', patch = nativePatch(before, after, 0)
  const value = fixture(before, after, patch, { path: 'after.ts', previousPath: 'before.ts', status: 'renamed' })
  const result = buildGitHubFilePatch(value, identityMasker)
  nativePreserved(result, patch)
  assert.equal(result.file.path, 'after.ts'); assert.equal(result.file.previousPath, 'before.ts')
  const valid = anchor(result, 0, 'RIGHT', 2)
  assert.doesNotThrow(() => validateReviewAnchor(valid, result))
  assert.throws(() => validateReviewAnchor({ ...valid, previousPath: 'other.ts' }, result), /workspace_review_anchor_invalid/)
  assert.throws(() => validateReviewAnchor({ ...valid, previousPath: undefined }, result), /workspace_review_anchor_invalid/)
})

test('complete before and after proofs are hash-checked even when their visible native hunk matches', () => {
  const before = 'private unchanged prefix\nold\n', after = 'private unchanged prefix\nnew\n'
  const value = fixture(before, after, nativePatch(before, after, 0))
  for (const change of [
    { before: Buffer.from('different unchanged prefix\nold\n') },
    { after: Buffer.from('different unchanged prefix\nnew\n') },
    { before: null }, { after: null },
    { file: { ...value.file, oldBlob: '0'.repeat(40) } },
    { file: { ...value.file, newBlob: '0'.repeat(40) } },
  ]) denied(() => buildGitHubFilePatch({ ...value, ...change }, identityMasker))
  const added = fixture(null, 'new\n', nativePatch('', 'new\n'))
  denied(() => buildGitHubFilePatch({ ...added, before: Buffer.alloc(0) }, identityMasker))
  const removed = fixture('old\n', null, nativePatch('old\n', ''))
  denied(() => buildGitHubFilePatch({ ...removed, after: Buffer.alloc(0) }, identityMasker))
})

test('a registered secret spanning two separate native hunks blocks the file before fragments escape', () => {
  const gap = Array.from({ length: 18 }, (_, i) => `ordinary middle ${i + 1}`).join('\n')
  const secret = `private fixture start\n${gap}\nprivate fixture end`
  const before = `public start\n${gap}\npublic end\n`, after = secret + '\n'
  const patch = nativePatch(before, after), value = fixture(before, after, patch)
  const mask = withCredentialMasking(createSecretMasker([{ name: 'MULTILINE_PRIVATE', value: secret }]))
  const unmasked = buildGitHubFilePatch(value, identityMasker)
  assert.equal(unmasked.hunks.length, 2)
  assert.equal(mask(patch), patch, 'masking only the native patch misses the full multiline value')
  for (const hunk of unmasked.hunks) {
    const fragment = hunk.lines.filter(line => !line.startsWith('-')).map(line => line.slice(1)).join('\n')
    assert.equal(mask(fragment), fragment, 'masking individual hunks also misses the secret')
  }
  assert.throws(() => buildGitHubFilePatch(value, mask), error =>
    error instanceof CodingWorkspaceError && error.code === 'workspace_path_unavailable')
})

test('full source masking covers omitted unchanged text, the removed side, and credential and EOL variants', () => {
  const secret = 'private fixture first\nprivate fixture second'
  const mask = withCredentialMasking(createSecretMasker([{ name: 'SOURCE_PRIVATE', value: secret }]))
  const prefix = secret + '\n' + 'ordinary\n'.repeat(20)
  const cases = [
    [prefix + 'old\n', prefix + 'new\n'],
    [secret + '\n', 'public\n'],
    ['old\n', secret.replace(/\n/g, '\r\n') + '\r\n'],
    ['old\n', 'ghp_012345678901234567890123456789\n'],
  ] as const
  for (const [before, after] of cases) assert.throws(() =>
    buildGitHubFilePatch(fixture(before, after, nativePatch(before, after)), mask), error =>
    error instanceof CodingWorkspaceError && error.code === 'workspace_path_unavailable')
})

test('native heading text and metadata cannot bypass masking of public patch data', () => {
  const secret = 'private-native-heading-value'
  const mask = createSecretMasker([{ name: 'HEADER_PRIVATE', value: secret }])
  const before = 'old\n', after = 'new\n'
  const patch = `@@ -1 +1 @@ ${secret}\n-old\n+new\n`
  denied(() => buildGitHubFilePatch(fixture(before, after, patch), mask))
  denied(() => buildGitHubFilePatch(fixture(before, after, nativePatch(before, after),
    { path: `${secret}.ts` }), mask))
})

test('a missing native GitHub patch returns unavailable metadata and never fabricates local anchors', () => {
  for (const value of [
    fixture('old\n', 'new\n', null),
    fixture('same\n', 'same\n', null, { oldMode: '100644', newMode: '100755' }),
    fixture('same\n', 'same\n', null, { path: 'new.ts', previousPath: 'old.ts', status: 'renamed' }),
  ]) {
    const result = buildGitHubFilePatch(value, identityMasker)
    assert.equal(result.format, 'unavailable'); assert.equal(result.patch, null); assert.deepEqual(result.hunks, [])
    assert.equal(result.file.fileVersion, value.file.fileVersion)
    assert.equal(result.file.path, value.file.path)
    assert.ok(diffFilePatch.safeParse(result).success)
  }
})

test('binary, invalid UTF-8, oversized and nonregular files remain content-free metadata', () => {
  const patch = '@@ -0,0 +1 @@\n+untrusted native text\n'
  for (const bytes of [Buffer.from([0, 1, 2]), Buffer.from([0xff, 0xfe])]) {
    const result = buildGitHubFilePatch(fixture(null, bytes, patch), identityMasker)
    assert.equal(result.format, 'binary'); assert.equal(result.file.binary, true)
    assert.equal(result.patch, null); assert.deepEqual(result.hunks, [])
  }
  const large = buildGitHubFilePatch(fixture(null, Buffer.alloc(WORKSPACE_DIFF_MAX_BLOB_BYTES + 1, 'x'), patch), identityMasker)
  assert.equal(large.format, 'too_large'); assert.equal(large.patch, null); assert.deepEqual(large.hunks, [])
  for (const mode of ['120000', '160000']) {
    const result = buildGitHubFilePatch(fixture(null, '../outside/private', patch,
      { newMode: mode, status: 'unavailable', unavailableReason: 'file_type' }), identityMasker)
    assert.equal(result.format, 'unavailable'); assert.equal(result.patch, null); assert.deepEqual(result.hunks, [])
  }
})

test('complete private proof bytes are neither mutated nor retained in the public DTO', () => {
  const hidden = 'complete-source-only-sentinel'
  const before = hidden + '\n' + 'ordinary\n'.repeat(20) + 'old\n'
  const after = hidden + '\n' + 'ordinary\n'.repeat(20) + 'new\n'
  const value = fixture(before, after, nativePatch(before, after, 0))
  const original = { ...value, file: { ...value.file }, before: Buffer.from(value.before!), after: Buffer.from(value.after!) }
  const result = buildGitHubFilePatch(value, identityMasker)
  nativePreserved(result, value.nativePatch!)
  assert.deepEqual(value, original)
  assert.deepEqual(Object.keys(result).sort(), ['file', 'format', 'hunks', 'patch', 'snapshotId', 'sourceVersion'])
  const json = JSON.stringify(result)
  for (const privateValue of [hidden, value.before!.toString('base64'), value.after!.toString('base64')])
    assert.equal(json.includes(privateValue), false)
  for (const key of ['before', 'after', 'nativePatch', 'blobs', 'base64'])
    assert.equal(Object.hasOwn(result, key), false)
})
