import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import type { PoolClient } from 'pg'
import type { RunCheckpoint } from '@mikka/protocol/device'
import { workspaceReadReceipt, type RunWorktreeIdentity, type WorkspaceReadReceipt } from '@mikka/protocol/coding-workspace'
import {
  checkpointReviewEvidence, diffSourceAccess, workspaceDiffReadRequest, WorkspaceReviewError,
  type DiffFileMetadata, type DiffRevision, type DiffSnapshot, type DiffSourceAccess, type WorkspaceDiffReadRequest,
} from '@mikka/protocol/coding-workspace-review'
import { identityMasker, type Masker } from '../../secrets/mask'
import { validateWorkspaceReceipt } from '../receipt'
import type { ReviewScope } from './authority'
import { prepareCheckpointReview } from './checkpoint'
import { buildDiffFilePatch, diffFileVersion, gitBlobHash } from './patch'
import { manifestRevision, retainDiffSnapshot } from './store'

const repoId = '11111111-2222-4333-8444-555555555555', baseSha = 'a'.repeat(40), headSha = 'b'.repeat(40), treeSha = 'c'.repeat(40)
const github: DiffSourceAccess = { kind: 'github', repositoryId: '61393725', manifestComplete: true }
const mask: Masker = Object.assign((value: string) => value, { sourcePolicy: 'd'.repeat(64) })
const unavailable = (error: unknown) => error instanceof WorkspaceReviewError && error.code === 'workspace_snapshot_unavailable'

function evidence(source: DiffRevision['source'] = 'commit', marker?: DiffFileMetadata['github'], access?: DiffSourceAccess) {
  const before = Buffer.from('old\n'), after = Buffer.from('new\n')
  const file: DiffFileMetadata = { path: 'source.ts', previousPath: null, status: 'modified',
    oldBlob: gitBlobHash(before, baseSha), newBlob: gitBlobHash(after, headSha), oldMode: '100644', newMode: '100644',
    oldSize: before.length, newSize: after.length, additions: 0, deletions: 0, binary: false, fileVersion: '0'.repeat(64),
    ...(marker ? { github: marker } : {}) }
  file.fileVersion = diffFileVersion(repoId, { baseSha, headSha }, file)
  const revision = manifestRevision(source, baseSha, headSha, source === 'working' ? null : treeSha, [file], access)
  return { file, revision, before, after }
}
const marker = (repositoryId = github.repositoryId): NonNullable<DiffFileMetadata['github']> =>
  ({ repositoryId, patchSha256: null, page: null })
function retained(source: DiffRevision['source'], access?: DiffSourceAccess, fileMarker?: DiffFileMetadata['github']) {
  const value = evidence(source, fileMarker, access)
  const pullRequest: DiffSnapshot['pullRequest'] = source === 'pull_request'
    ? { number: access?.pullRequestNumber ?? 1, url: 'https://github.com/mikka-fixtures/source-access/pull/1', headSha, state: 'open' } : null
  return { revision: value.revision, files: [value.file], sourceAccess: access, pullRequest }
}

test('local file and manifest versions preserve the exact pre-GitHub hash contract', () => {
  const expected = {
    working: '7b8a9a5891b5deb2261f3c6f6ae13001a22e815789cd225232e4460f661e5755',
    commit: 'cd5ff6e681e56f6a10156b5735b1dcd54484d97c48a15e86d35bdbb0bf44c45b',
    checkpoint: '42997866380c002a739b8047a0a6d5547b17ac561126bf3785cc459bf52012f7',
  }
  for (const source of ['working', 'commit', 'checkpoint'] as const) {
    const value = evidence(source)
    assert.equal(value.file.fileVersion, '6cbac8cf5f5f2349f0dd7d31d10c45b05e5b2aefe37985fec2dd91cfa9126919')
    assert.equal(value.revision.version, expected[source])
    assert.equal(value.file.github, undefined)
  }
})

test('origin and PR identity distinguish snapshot versions even for an empty manifest', () => {
  for (const files of [[], [evidence().file]]) {
    const local = manifestRevision('commit', baseSha, headSha, treeSha, files)
    const remote = manifestRevision('commit', baseSha, headSha, treeSha, files, github)
    assert.notEqual(local.version, remote.version)
    assert.notEqual(remote.version,
      manifestRevision('commit', baseSha, headSha, treeSha, files, { ...github, repositoryId: '61393726' }).version)
    const first = manifestRevision('pull_request', baseSha, headSha, treeSha, files, { ...github, pullRequestNumber: 1 })
    const second = manifestRevision('pull_request', baseSha, headSha, treeSha, files, { ...github, pullRequestNumber: 2 })
    assert.notEqual(first.version, second.version)
    assert.notEqual(first.version, manifestRevision('pull_request', baseSha, headSha, treeSha, files).version)
    assert.deepEqual(first, manifestRevision('pull_request', baseSha, headSha, treeSha, files, { ...github, pullRequestNumber: 1 }))
  }
})

test('sourceAccess requires a complete manifest and bounded concrete GitHub identity', () => {
  assert.deepEqual(diffSourceAccess.parse(github), github)
  assert.ok(diffSourceAccess.safeParse({ ...github, pullRequestNumber: 1 }).success)
  for (const change of [{ kind: 'daemon' }, { manifestComplete: false }, { manifestComplete: undefined },
    { repositoryId: '0' }, { repositoryId: '0123' }, { repositoryId: 'other/repo' }, { repositoryId: '1'.repeat(41) },
    { pullRequestNumber: 0 }, { pullRequestNumber: 1.5 }, { pullRequestNumber: Number.MAX_SAFE_INTEGER + 1 },
    { canRead: true }]) assert.equal(diffSourceAccess.safeParse({ ...github, ...change }).success, false)
})

test('retention refuses forged source provenance before any database read or write', async () => {
  const identity: ReviewScope['identity'] = { version: 1, runId: randomUUID(), repoId, workspaceId: randomUUID(),
    ownerId: 'source-access-owner', repositoryKey: 'v2/github.com/mikka-fixtures/source-access' }
  const scope: ReviewScope = { identity, taskId: null, boardId: randomUUID(), status: 'stopped', stopped: true }
  let queries = 0
  const client = { async query() { queries++; throw new Error('Rejected source provenance must not reach persistence') } } as unknown as PoolClient
  const prAccess: DiffSourceAccess = { ...github, pullRequestNumber: 1 }
  const pr = retained('pull_request', prAccess, marker()), commit = retained('commit', github, marker())
  const cases = [
    retained('working', github, marker()), retained('checkpoint', github, marker()),
    retained('pull_request'), retained('commit', undefined, marker()), retained('commit', github),
    retained('commit', github, marker('61393726')),
    retained('commit', prAccess, marker()), retained('pull_request', github, marker()),
    { ...commit, pullRequest: pr.pullRequest }, { ...pr, pullRequest: null },
    { ...pr, pullRequest: { ...pr.pullRequest!, number: 2 } },
    { ...pr, sourceAccess: { ...prAccess, pullRequestNumber: 2 } },
    { ...commit, revision: evidence().revision },
    { ...commit, sourceAccess: { ...github, repositoryId: '61393726' } },
  ]
  for (const value of cases) await assert.rejects(() => retainDiffSnapshot(client, scope, value, mask), unavailable)
  assert.equal(queries, 0)
})

function wire(fileMarker?: DiffFileMetadata['github']) {
  const value = evidence('commit', fileMarker), snapshotId = randomUUID()
  const identity: RunWorktreeIdentity = { version: 1, runId: randomUUID(), repoId, deviceId: randomUUID(),
    workspaceId: randomUUID(), ownerId: 'source-access-owner', repositoryKey: 'v2/github.com/mikka-fixtures/source-access', bindingId: 'e'.repeat(64) }
  const request: Extract<WorkspaceDiffReadRequest, { kind: 'diff_file' }> = { kind: 'diff_file', snapshotId,
    revision: value.revision, file: value.file }
  const receipt: WorkspaceReadReceipt = { result: { ok: true, kind: 'diff_file', identity, snapshotId,
    revision: value.revision, sourceVersion: value.revision.version, file: value.file,
    observedAt: '2026-11-08T12:00:00.000Z', availability: 'online', format: 'text', patch: null, hunks: [] },
  files: [], blobs: [{ sha: value.file.oldBlob!, base64: value.before.toString('base64') },
    { sha: value.file.newBlob!, base64: value.after.toString('base64') }] }
  return { ...value, identity, request, receipt }
}

test('a daemon cannot claim GitHub provenance in otherwise valid full file receipts or read requests', () => {
  const local = wire()
  assert.ok(workspaceDiffReadRequest.safeParse(local.request).success)
  assert.ok(validateWorkspaceReceipt(local.request, local.identity, local.receipt, identityMasker)?.ok)
  const forged = wire(marker())
  assert.ok(workspaceReadReceipt.safeParse(forged.receipt).success, 'the rejection must inspect provenance, not fail an unrelated wire field')
  assert.equal(workspaceDiffReadRequest.safeParse(forged.request).success, false)
  assert.equal(validateWorkspaceReceipt(forged.request, forged.identity, forged.receipt, identityMasker), null)
})

test('a daemon snapshot with correctly recomputed file and manifest hashes still cannot claim GitHub files', () => {
  for (const fileMarker of [undefined, marker()]) {
    const value = wire(fileMarker)
    const request = { kind: 'diff_snapshot', source: 'commit', baseSha, headSha } as const
    const receipt: WorkspaceReadReceipt = { result: { ok: true, kind: 'diff_snapshot', identity: value.identity,
      revision: value.revision, files: [value.file], observedAt: '2026-11-08T12:00:00.000Z', availability: 'online' }, files: [] }
    assert.ok(workspaceReadReceipt.safeParse(receipt).success)
    const verified = validateWorkspaceReceipt(request, value.identity, receipt, identityMasker)
    if (fileMarker) assert.equal(verified, null)
    else assert.deepEqual(verified, receipt.result)
  }
})

test('checkpoint source proofs cannot manufacture GitHub authority even with valid hashes and full blobs', () => {
  for (const fileMarker of [undefined, marker()]) {
    const value = evidence('checkpoint', fileMarker)
    const patch = buildDiffFilePatch({ snapshotId: randomUUID(), sourceVersion: value.revision.version,
      file: value.file, before: value.before, after: value.after }, mask)
    const proof = checkpointReviewEvidence.parse({ version: 1, repoId, revision: value.revision, files: [value.file],
      blobs: [{ sha: value.file.oldBlob, base64: value.before.toString('base64') },
        { sha: value.file.newBlob, base64: value.after.toString('base64') }], reason: null })
    const checkpoint: RunCheckpoint = { baseCommit: baseSha, patch: gzipSync(patch.patch!).toString('base64'),
      files: 1, takenAt: '2026-11-08T12:00:00.000Z', review: proof }
    const prepared = prepareCheckpointReview(checkpoint, repoId, mask)
    if (fileMarker) { assert.equal(prepared.reason, 'missing_evidence'); assert.equal(prepared.input, undefined) }
    else {
      assert.equal(prepared.reason, null); assert.ok(prepared.input)
      assert.ok(prepared.input.patches?.get('source.ts'))
      assert.equal(prepared.input.sourceAccess, undefined)
    }
  }
})
