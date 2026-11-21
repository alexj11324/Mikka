import assert from 'node:assert/strict'
import test from 'node:test'
import type { DiffFileMetadata, DiffFilePatch, DiffSnapshot } from '@mikka/protocol/coding-workspace-review'
import { getReviewSummary, getReviewDiff, getReviewFile } from '../../code-review/client'
import { projectTaskReviewSummary, reviewReference, taskReviewDiff, taskReviewFile } from './projection'

const snapshotId = '20000000-0000-4000-8000-000000000001'
const sourceVersion = 'a'.repeat(64)
const baseSha = '1'.repeat(40), headSha = '2'.repeat(40)
const observedAt = '2026-11-01T02:03:04.567Z'
const patchText = '--- a/source.ts\n+++ b/source.ts\n@@ -1 +1,2 @@\n-old\n+new\n+extra\n'

// These are typed metadata projections, not source-proof or provider tests.
const metadata = (changes: Partial<DiffFileMetadata> = {}): DiffFileMetadata => ({
  path: 'source.ts', previousPath: null, status: 'modified',
  oldBlob: '3'.repeat(40), newBlob: '4'.repeat(40), oldMode: '100644', newMode: '100644',
  additions: 0, deletions: 0, binary: false, fileVersion: 'b'.repeat(64), ...changes,
})
const patchFor = (file: DiffFileMetadata, format: DiffFilePatch['format'] = 'text', changes: Partial<DiffFilePatch> = {}): DiffFilePatch => ({
  snapshotId, sourceVersion, file, format, patch: format === 'text' ? patchText : null, hunks: [], ...changes,
})
const snapshot = (source: DiffSnapshot['revision']['source'] = 'working', changes: Partial<DiffSnapshot> = {}): DiffSnapshot => ({
  id: snapshotId,
  identity: { version: 1, runId: '20000000-0000-4000-8000-000000000002',
    repoId: '20000000-0000-4000-8000-000000000003', workspaceId: '20000000-0000-4000-8000-000000000004',
    ownerId: 'projection-owner', repositoryKey: 'v2/github.com/fixture/projection' },
  taskId: '20000000-0000-4000-8000-000000000005',
  revision: { source, baseSha, headSha, treeSha: source === 'checkpoint' ? '5'.repeat(40) : null, version: sourceVersion },
  observedAt, isStale: false, availability: 'available', reason: null,
  counts: { files: 1, additions: 0, deletions: 0, complete: false },
  policy: source === 'working' ? 'combined_working_tree' : source === 'checkpoint' ? 'retained_checkpoint'
    : source === 'commit' ? 'explicit_commits' : 'whole_pull_request',
  pullRequest: source === 'pull_request' ? { number: 7, url: 'https://github.com/fixture/projection/pull/7',
    baseSha: '6'.repeat(40), headSha, state: 'open' } : null,
  ...changes,
})
const idle = { running: false, reclaimed: false, nextCursor: null }

test('unloaded metadata counts remain unknown, including manifest placeholder zeroes', () => {
  for (const [additions, deletions] of [[0, 0], [17, 9]]) {
    const file = taskReviewFile(metadata({ additions, deletions }), { comments: 0 })
    assert.equal(file.additions, null); assert.equal(file.deletions, null)
    assert.equal(file.countsKnown, false); assert.equal(file.format, 'unloaded')
    assert.equal(file.patch, null); assert.equal(file.tooLarge, false)
  }
})

test('verified text counts replace raw manifest zeroes and preserve the exact patch', () => {
  const file = metadata(), loaded = patchFor({ ...file, additions: 2, deletions: 1 })
  const result = taskReviewFile(file, { patch: loaded, reviewed: true, comments: 3 })
  assert.equal(result.additions, 2); assert.equal(result.deletions, 1); assert.equal(result.countsKnown, true)
  assert.equal(result.patch, patchText); assert.equal(result.format, 'text')
  assert.equal(result.fileVersion, file.fileVersion); assert.equal(result.viewed, true); assert.equal(result.comments, 3)
})

test('explicit retained count knowledge is independent of whether the patch is in this response', () => {
  const file = metadata({ additions: 8, deletions: 4 })
  const retained = taskReviewFile(file, { patch: null, countsKnown: true, comments: 0 })
  assert.equal(retained.additions, 8); assert.equal(retained.deletions, 4); assert.equal(retained.countsKnown, true)
  assert.equal(retained.format, 'unloaded'); assert.equal(retained.patch, null)
  const unknown = taskReviewFile(file, { patch: patchFor(file), countsKnown: false, comments: 0 })
  assert.equal(unknown.additions, null); assert.equal(unknown.deletions, null); assert.equal(unknown.countsKnown, false)
})

test('unloaded, binary, too-large and unavailable files remain distinct', async t => {
  const cases: { name: string; file: DiffFileMetadata; patch: DiffFilePatch | null; format: string; known: boolean; large: boolean }[] = [
    { name: 'unloaded', file: metadata(), patch: null, format: 'unloaded', known: false, large: false },
    { name: 'binary', file: metadata({ binary: true }), patch: patchFor(metadata({ binary: true }), 'binary'),
      format: 'binary', known: true, large: false },
    { name: 'too large', file: metadata({ newSize: 1024 * 1024 + 1 }), patch: patchFor(metadata(), 'too_large'),
      format: 'too_large', known: false, large: true },
    { name: 'unsupported file type', file: metadata({ newMode: '120000', unavailableReason: 'file_type' }),
      patch: patchFor(metadata({ newMode: '120000', unavailableReason: 'file_type' }), 'unavailable'),
      format: 'unavailable', known: false, large: false },
  ]
  for (const entry of cases) await t.test(entry.name, () => {
    const file = taskReviewFile(entry.file, { patch: entry.patch, comments: 0 })
    assert.equal(file.format, entry.format); assert.equal(file.patch, null)
    assert.equal(file.countsKnown, entry.known); assert.equal(file.tooLarge, entry.large)
    assert.equal(file.additions, entry.known ? 0 : null); assert.equal(file.deletions, entry.known ? 0 : null)
  })
})

test('renames and unavailable statuses survive without manufacturing another path or review state', () => {
  const renamed = taskReviewFile(metadata({ path: 'new.ts', previousPath: 'old.ts', status: 'renamed' }), { comments: 2 })
  assert.equal(renamed.path, 'new.ts'); assert.equal(renamed.previousPath, 'old.ts'); assert.equal(renamed.status, 'renamed')
  assert.equal(renamed.viewed, false); assert.equal(renamed.comments, 2)
  const unavailable = taskReviewFile(metadata({ status: 'unavailable' }), { comments: 0 })
  assert.equal(unavailable.status, 'unavailable'); assert.equal(Object.hasOwn(unavailable, 'previousPath'), false)
})

test('private raw proof metadata and GitHub locators never enter either public projection', () => {
  const file = metadata({ rawBlob: '7'.repeat(40), rawSize: 1_234_567, workingVersion: '8'.repeat(64),
    oldSize: 10, newSize: 12, github: { repositoryId: '900719925474099312345', patchSha256: '9'.repeat(64), page: 23 } })
  const source = snapshot('pull_request', { sourceAccess: { kind: 'github', repositoryId: file.github!.repositoryId,
    pullRequestNumber: 7, manifestComplete: true } })
  const projected = taskReviewFile(file, { patch: patchFor(file), comments: 0 })
  const result = taskReviewDiff(source, [projected], idle)
  const encoded = JSON.stringify(result)
  for (const key of ['rawBlob', 'rawSize', 'workingVersion', 'github', 'repositoryId', 'patchSha256', 'page',
    'oldBlob', 'newBlob', 'oldMode', 'newMode', 'oldSize', 'newSize', 'sourceAccess', 'identity', 'hunks'])
    assert.equal(encoded.includes('"' + key + '":'), false, key + ' must remain private')
  for (const value of [file.rawBlob!, file.workingVersion!, file.github!.repositoryId, file.github!.patchSha256!])
    assert.equal(encoded.includes(value), false, 'private metadata values are not copied into public fields')
  assert.equal(projected.fileVersion, file.fileVersion)
  assert.deepEqual(result.reviewRef, { snapshotId, sourceVersion })
})

test('working, checkpoint, explicit commit and whole PR sources retain their own provenance and actual time', async t => {
  for (const [kind, projectedKind] of [['working', 'machine'], ['checkpoint', 'checkpoint'], ['commit', 'commit'], ['pull_request', 'pr']] as const)
    await t.test(kind, () => {
      const source = snapshot(kind)
      const result = taskReviewDiff(source, [], { ...idle, reclaimed: kind !== 'working' })
      assert.equal(result.source.kind, projectedKind); assert.equal(result.source.at, observedAt)
      assert.equal(result.source.reclaimed, kind !== 'working'); assert.equal(result.source.stale, false)
      assert.equal(result.base, baseSha); assert.equal(result.head, headSha)
      assert.deepEqual(result.reviewRef, { snapshotId, sourceVersion })
      if (source.pullRequest) assert.notEqual(result.base, source.pullRequest.baseSha, 'PR target tip cannot replace the verified diff base')
    })
})

test('a reclaimed legacy checkpoint preserves its missing HEAD instead of substituting its base or tree', () => {
  const source = snapshot('checkpoint')
  source.revision.headSha = null
  const result = taskReviewDiff(source, [], { ...idle, reclaimed: true })
  assert.equal(result.source.kind, 'checkpoint'); assert.equal(result.source.at, observedAt)
  assert.equal(result.source.reclaimed, true); assert.equal(result.live, false)
  assert.equal(result.base, baseSha); assert.equal(result.head, null)
})

test('unavailable snapshots have no review reference, no invented commit IDs and no empty-success state', () => {
  const source = snapshot('working', { availability: 'unavailable', reason: 'machine_unavailable' })
  source.revision.baseSha = null; source.revision.headSha = null
  source.counts = { files: 0, additions: 0, deletions: 0, complete: false }
  const result = taskReviewDiff(source, [], idle)
  assert.equal(result.reviewRef, null); assert.equal(result.base, null); assert.equal(result.head, null)
  assert.equal(result.availability, 'unavailable'); assert.equal(result.reason, 'machine_unavailable')
  assert.equal(result.empty, false); assert.equal(result.live, false); assert.equal(result.source.at, observedAt)
})

test('only an available fresh running working source may be marked live', async t => {
  const cases = [
    { name: 'fresh active worktree', source: snapshot(), running: true, reclaimed: false, live: true },
    { name: 'stopped worktree', source: snapshot(), running: false, reclaimed: false, live: false },
    { name: 'stale worktree', source: snapshot('working', { isStale: true }), running: true, reclaimed: false, live: false },
    { name: 'unavailable worktree', source: snapshot('working', { availability: 'unavailable', reason: 'machine_unavailable' }),
      running: true, reclaimed: false, live: false },
    { name: 'reclaimed worktree', source: snapshot(), running: true, reclaimed: true, live: false },
    ...(['checkpoint', 'commit', 'pull_request'] as const).map(kind => ({ name: kind, source: snapshot(kind), running: true, reclaimed: false, live: false })),
  ]
  for (const entry of cases) await t.test(entry.name, () => {
    const result = taskReviewDiff(entry.source, [], { running: entry.running, reclaimed: entry.reclaimed, nextCursor: null })
    assert.equal(result.live, entry.live)
    assert.equal(result.source.reclaimed, entry.reclaimed); assert.equal(result.source.stale, entry.source.isStale)
  })
})

test('metadata zero counts, a mode-only patch and an empty page are not proof of an empty snapshot', () => {
  const raw = metadata(), unloaded = taskReviewFile(raw, { comments: 0 })
  const modeOnly = taskReviewFile({ ...raw, newMode: '100755' }, { patch: patchFor({ ...raw, newMode: '100755' }, 'text', { patch: '' }), comments: 0 })
  assert.equal(modeOnly.patch, ''); assert.equal(modeOnly.countsKnown, true); assert.equal(modeOnly.additions, 0); assert.equal(modeOnly.deletions, 0)
  for (const files of [[unloaded], [modeOnly], []]) {
    const result = taskReviewDiff(snapshot(), files, { ...idle, nextCursor: 'opaque-following-page' })
    assert.equal(result.empty, false); assert.equal(result.availability, 'available')
    assert.equal(result.nextCursor, 'opaque-following-page')
  }
  const empty = snapshot('working', { availability: 'empty', counts: { files: 0, additions: 0, deletions: 0, complete: true } })
  const result = taskReviewDiff(empty, [], idle)
  assert.equal(result.empty, true); assert.deepEqual(result.files, [])
  assert.deepEqual(result.reviewRef, { snapshotId, sourceVersion })
  assert.equal(Object.hasOwn(result, 'nextCursor'), false)
})

test('snapshot references preserve both immutable identities across time, pages and equal HEAD values', () => {
  const first = snapshot(), reference = { snapshotId: first.id, sourceVersion: first.revision.version }
  assert.deepEqual(reviewReference(first), reference)
  const reread = { ...first, observedAt: '2026-11-08T09:10:11.123Z', isStale: true }
  assert.deepEqual(reviewReference(reread), reference)
  assert.deepEqual(taskReviewDiff(reread, [], { ...idle, nextCursor: 'page-2' }).reviewRef, reference)
  const sameHead = { ...first, revision: { ...first.revision, version: 'c'.repeat(64) } }
  assert.equal(sameHead.revision.headSha, first.revision.headSha)
  assert.notDeepEqual(reviewReference(sameHead), reference, 'HEAD alone cannot stand in for the working source version')
  const otherSnapshot = { ...first, id: '20000000-0000-4000-8000-000000000006' }
  assert.notDeepEqual(reviewReference(otherSnapshot), reference, 'matching content cannot replace snapshot identity')
  assert.deepEqual(Object.keys(reviewReference(first)).sort(), ['snapshotId', 'sourceVersion'])
})

test('Task and Review page readers consume the actual authorized checkpoint projection', async t => {
  const source = snapshot('checkpoint')
  source.revision.headSha = null
  const actor = { userId: source.identity.ownerId, workspaceId: source.identity.workspaceId, credential: { kind: 'session' as const, id: 'session' } }
  const scope = { identity: source.identity, taskId: source.taskId, status: 'completed', stopped: true, boardId: 'board' }
  const summary = projectTaskReviewSummary(actor, scope, source, undefined, null)
  const teammate = projectTaskReviewSummary({ ...actor, userId: 'viewer' }, scope, source, undefined, null)
  const file = taskReviewFile(metadata(), { comments: 0 })
  const diff = taskReviewDiff(source, [file], { ...idle, reclaimed: true })
  let reply: unknown = summary
  const requests = t.mock.method(globalThis, 'fetch', async () => Response.json(reply))
  const read = await getReviewSummary(source.taskId!)
  assert.ok(read)
  assert.equal(read.files, 1)
  assert.equal(read.additions, null)
  assert.equal(read.deletions, null)
  assert.equal(read.checks, null)
  assert.equal(read.permissions.reasons.merge, 'review_unavailable')
  assert.equal(read.permissions.canSend, true)
  assert.deepEqual(read.reviewRef, reviewReference(source))
  reply = teammate
  const other = await getReviewSummary(source.taskId!)
  assert.ok(other)
  assert.equal(other.permissions.canSend, false)
  assert.equal(other.permissions.reasons.send, 'not_owner_send')
  reply = { summary, diff }
  const opened = await getReviewDiff(source.taskId!)
  assert.ok(opened)
  assert.equal(opened.diff.head, null)
  assert.equal(opened.diff.files[0].additions, null)
  assert.equal(opened.diff.files[0].fileVersion, metadata().fileVersion)
  const loaded = taskReviewFile(metadata(), { patch: patchFor(metadata()), comments: 0 })
  reply = { reviewRef: reviewReference(source), file: loaded, comments: [] }
  assert.equal((await getReviewFile(source.taskId!, file.path, reviewReference(source))).file.patch, patchText)
  assert.equal(requests.mock.callCount(), 4)
})
