import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHECKPOINT_REVIEW_MAX_PROOF_BYTES, WORKSPACE_DIFF_MAX_BLOB_BYTES, checkpointReviewEvidence,
  type CheckpointReviewEvidence } from '@mikka/protocol/coding-workspace-review'
import { applyCheckpoint, assertCheckpointFresh, takeCheckpoint, type TakenCheckpoint } from '../src/agents/checkpoint'
import * as publish from '../src/agents/publish'
import { cleanupTempDirs, makeRepo, tempDir } from './helpers'

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Checkpoint Review Fixture',
  '-c', 'user.email=checkpoint-review@mikka.invalid', '-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', ...args],
{ cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
const blobId = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

async function fixture() {
  const repoPath = await makeRepo()
  git(repoPath, 'config', 'core.autocrlf', 'false')
  git(repoPath, 'config', 'core.filemode', 'true')
  for (const [path, text] of [['tracked.txt', 'frozen original source\n'], ['rename.txt', 'unique exact rename contents\n'],
    ['deleted.txt', 'deleted original contents\n'], ['mode.sh', '#!/bin/sh\nprintf "fixture\\n"\n']]) {
    writeFileSync(join(repoPath, path!), text!)
  }
  chmodSync(join(repoPath, 'mode.sh'), 0o644)
  writeFileSync(join(repoPath, 'binary.bin'), Buffer.from([0, 1, 2, 255]))
  git(repoPath, 'add', '--all')
  git(repoPath, 'commit', '-qm', 'checkpoint review baseline')
  const directory = tempDir('mikka-checkpoint-review-'), worktree = join(directory, 'checkout')
  git(repoPath, 'worktree', 'add', '-q', '--detach', worktree, 'HEAD')
  const repoId = randomUUID(), baseCommit = git(worktree, 'rev-parse', 'HEAD')
  const write = (path: string, value: string | Buffer) => writeFileSync(join(worktree, path), value)
  const commit = () => { git(worktree, 'add', '--all'); git(worktree, 'commit', '-qm', 'fixture changes'); return git(worktree, 'rev-parse', 'HEAD') }
  return { repoPath, repoId, baseCommit, directory, worktree, write, commit }
}
type Fixture = Awaited<ReturnType<typeof fixture>>

async function capture(f: Fixture, options: { lastTree?: string; lastHead?: string | null } = {}) {
  const snapshot = await takeCheckpoint({ repoPath: f.repoPath, worktree: f.worktree, baseCommit: f.baseCommit, repoId: f.repoId, ...options })
  expect(snapshot).not.toBeNull()
  if (!snapshot) throw Error('Expected a new checkpoint')
  return snapshot
}

function review(snapshot: TakenCheckpoint) {
  const evidence = checkpointReviewEvidence.parse(snapshot.checkpoint.review)
  expect(evidence.revision).toMatchObject({ source: 'checkpoint', baseSha: snapshot.checkpoint.baseCommit,
    headSha: snapshot.head, treeSha: snapshot.tree })
  expect(evidence.revision.version).toMatch(/^[a-f0-9]{64}$/)
  return evidence
}

/** Git's object store is the independent oracle, including complete binary bytes. */
function verifiedProofs(f: Fixture, evidence: CheckpointReviewEvidence) {
  expect(new Set(evidence.blobs.map(proof => proof.sha)).size).toBe(evidence.blobs.length)
  const result = new Map<string, Buffer>()
  for (const proof of evidence.blobs) {
    expect(Object.keys(proof).sort()).toEqual(['base64', 'sha'])
    const bytes = Buffer.from(proof.base64, 'base64')
    expect(bytes.toString('base64')).toBe(proof.base64)
    expect(bytes.length).toBeLessThanOrEqual(WORKSPACE_DIFF_MAX_BLOB_BYTES)
    expect(blobId(bytes)).toBe(proof.sha)
    const actual = execFileSync('git', ['cat-file', 'blob', proof.sha], { cwd: f.repoPath, stdio: ['ignore', 'pipe', 'pipe'] })
    expect(bytes.equals(actual)).toBe(true)
    result.set(proof.sha, bytes)
  }
  expect([...result.values()].reduce((bytes, value) => bytes + value.length, 0)).toBeLessThanOrEqual(CHECKPOINT_REVIEW_MAX_PROOF_BYTES)
  for (const file of evidence.files) {
    if (file.oldBlob) expect(git(f.repoPath, 'rev-parse', `${evidence.revision.baseSha}:${file.previousPath ?? file.path}`)).toBe(file.oldBlob)
    if (file.newBlob) expect(git(f.repoPath, 'rev-parse', `${evidence.revision.treeSha}:${file.path}`)).toBe(file.newBlob)
    for (const [sha, size] of [[file.oldBlob, file.oldSize], [file.newBlob, file.newSize]] as const) {
      if (sha && result.has(sha)) expect(result.get(sha)!.length).toBe(size)
    }
  }
  return result
}

function restoredWorktree(f: Fixture) {
  const worktree = join(tempDir('mikka-checkpoint-restored-'), 'checkout')
  git(f.repoPath, 'worktree', 'add', '-q', '--detach', worktree, f.baseCommit)
  return worktree
}

/** The clean command is real and runs in Git's native snapshot, not a mocked runner. */
function installFilter(f: Fixture, extra = '') {
  const script = join(f.directory, 'clean.cjs'), counter = join(f.directory, 'clean-count.txt')
  writeFileSync(script, `const fs = require('node:fs');\nconst { execFileSync } = require('node:child_process');\n` +
    `fs.appendFileSync(${JSON.stringify(counter)}, 'clean\\n');\n${extra}\nprocess.stdout.write(fs.readFileSync(0));\n`)
  git(f.repoPath, 'config', 'filter.checkpoint-review.clean', `${quote(process.execPath)} ${quote(script)}`)
  git(f.repoPath, 'config', 'filter.checkpoint-review.smudge', 'cat')
  git(f.repoPath, 'config', 'filter.checkpoint-review.required', 'true')
  f.write('.gitattributes', 'filtered.txt filter=checkpoint-review\n')
  f.write('filtered.txt', 'filter baseline\n')
  f.baseCommit = f.commit()
  writeFileSync(counter, '')
  return { script, counter }
}

afterEach(() => { vi.restoreAllMocks(); cleanupTempDirs() })

describe('checkpoint review evidence from real Git objects', () => {
  it('binds complete source proofs to the frozen base and captured tree for text, binary, rename, deletion and mode changes', async () => {
    const f = await fixture()
    f.write('committed.txt', 'already committed during this run\n')
    const head = f.commit()
    f.write('tracked.txt', 'staged intermediate source\n'); git(f.worktree, 'add', '--', 'tracked.txt')
    f.write('tracked.txt', 'actual worktree source\n')
    f.write('binary.bin', Buffer.from([0, 255, 128, 0, 3]))
    f.write('untracked.txt', 'new untracked source\n')
    renameSync(join(f.worktree, 'rename.txt'), join(f.worktree, 'moved.txt'))
    rmSync(join(f.worktree, 'deleted.txt'))
    chmodSync(join(f.worktree, 'mode.sh'), 0o755)
    f.write('.env.local', 'IGNORED_FIXTURE_ONLY=never-review-this\n')
    const index = git(f.worktree, 'ls-files', '--stage', '-z')
    const snapshot = await capture(f), evidence = review(snapshot), proofs = verifiedProofs(f, evidence)
    expect(evidence.repoId).toBe(f.repoId)
    expect(evidence.reason).toBeNull()
    expect(snapshot.head).toBe(head)
    expect(snapshot.tree).not.toBe(head)
    expect(git(f.repoPath, 'cat-file', '-t', snapshot.tree)).toBe('tree')
    expect(git(f.worktree, 'ls-files', '--stage', '-z')).toBe(index)
    expect(evidence.files.map(file => file.path)).toEqual(['binary.bin', 'committed.txt', 'deleted.txt', 'mode.sh', 'moved.txt', 'tracked.txt', 'untracked.txt'])
    const byPath = (path: string) => evidence.files.find(file => file.path === path)!
    expect(byPath('moved.txt')).toMatchObject({ status: 'renamed', previousPath: 'rename.txt' })
    expect(byPath('moved.txt').oldBlob).toBe(byPath('moved.txt').newBlob)
    expect(byPath('deleted.txt')).toMatchObject({ status: 'deleted', newBlob: null, newMode: null })
    expect(byPath('mode.sh')).toMatchObject({ status: 'modified', oldMode: '100644', newMode: '100755' })
    expect(byPath('mode.sh').oldBlob).toBe(byPath('mode.sh').newBlob)
    expect(proofs.get(byPath('tracked.txt').newBlob!)!.toString()).toBe('actual worktree source\n')
    expect(proofs.get(byPath('binary.bin').newBlob!)!.equals(Buffer.from([0, 255, 128, 0, 3]))).toBe(true)
    for (const file of evidence.files) for (const sha of [file.oldBlob, file.newBlob]) if (sha) expect(proofs.has(sha)).toBe(true)
    expect([...proofs.values()].some(bytes => bytes.toString().includes('staged intermediate source'))).toBe(false)
    expect([...proofs.values()].some(bytes => bytes.toString().includes('IGNORED_FIXTURE_ONLY'))).toBe(false)
  })

  it('does not skip an unchanged tree after HEAD advances, then deduplicates the exact head and tree', async () => {
    const f = await fixture()
    f.write('tracked.txt', 'work captured before its commit\n')
    const first = await capture(f), firstReview = review(first)
    const nextHead = f.commit()
    const second = await capture(f, { lastTree: first.tree, lastHead: first.head }), secondReview = review(second)
    expect(second.tree).toBe(first.tree)
    expect(second.head).toBe(nextHead)
    expect(second.head).not.toBe(first.head)
    expect(secondReview.revision.baseSha).toBe(firstReview.revision.baseSha)
    expect(secondReview.revision.version).not.toBe(firstReview.revision.version)
    expect(secondReview.files[0]!.fileVersion).not.toBe(firstReview.files[0]!.fileVersion)
    expect(second.checkpoint.patch).toBe(first.checkpoint.patch)
    verifiedProofs(f, secondReview)
    expect(await takeCheckpoint({ repoPath: f.repoPath, worktree: f.worktree, baseCommit: f.baseCommit,
      repoId: f.repoId, lastTree: second.tree, lastHead: second.head })).toBeNull()
  })

  it('captures a real empty review when work is reverted, while optional evidence does not change legacy recovery', async () => {
    const f = await fixture()
    f.write('tracked.txt', 'temporary work\n')
    const changed = await capture(f)
    git(f.worktree, 'checkout', '--', 'tracked.txt')
    const clean = await capture(f, { lastTree: changed.tree, lastHead: changed.head }), evidence = review(clean)
    expect(evidence).toMatchObject({ reason: null, files: [], blobs: [] })
    expect(clean.checkpoint.files).toBe(0)
    expect(gunzipSync(Buffer.from(clean.checkpoint.patch, 'base64')).length).toBe(0)
    const legacy = await takeCheckpoint({ repoPath: f.repoPath, worktree: f.worktree, baseCommit: f.baseCommit })
    expect(legacy!.checkpoint.review).toBeUndefined()
    expect(await takeCheckpoint({ repoPath: f.repoPath, worktree: f.worktree, baseCommit: f.baseCommit, lastTree: legacy!.tree })).toBeNull()
  })

  it('adds no clean filter passes beyond one native snapshot and prints no private source or filter diagnostics', async () => {
    const f = await fixture(), { script, counter } = installFilter(f)
    const sentinel = `checkpoint-private-fixture-${randomUUID()}`
    writeFileSync(script, readFileSync(script, 'utf8').replace('process.stdout.write',
      `process.stderr.write(${JSON.stringify(sentinel)});\nprocess.stdout.write`))
    f.write('filtered.txt', `${sentinel}\n`)
    // Native clean passes can vary with Git's index stat cache. Record the real
    // snapshot inside this capture, then require the review to add no passes.
    const realSnapshotTree = publish.snapshotTree
    let nativeTree: string | undefined, nativePasses: string | undefined
    const snapshotCall = vi.spyOn(publish, 'snapshotTree').mockImplementation(async (...args) => {
      const tree = await realSnapshotTree(...args)
      nativeTree = tree
      nativePasses = readFileSync(counter, 'utf8')
      return tree
    })
    const calls: unknown[][] = []
    for (const method of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation((...values) => { calls.push(values) })
    const snapshot = await capture(f), evidence = review(snapshot)
    expect(snapshotCall).toHaveBeenCalledTimes(1)
    expect(snapshotCall).toHaveBeenCalledWith(f.repoPath, f.worktree)
    expect(nativePasses).toMatch(/^(clean\n)+$/)
    expect(evidence.reason).toBeNull()
    expect(snapshot.tree).toBe(nativeTree)
    expect(readFileSync(counter, 'utf8')).toBe(nativePasses)
    const proofs = verifiedProofs(f, evidence), file = evidence.files.find(file => file.path === 'filtered.txt')!
    expect(proofs.get(file.newBlob!)!.toString()).toBe(`${sentinel}\n`)
    expect(readFileSync(counter, 'utf8')).toBe(nativePasses)
    expect(snapshotCall).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([])
  })

  it('keeps oversized files as metadata and omits both of their proofs without invalidating recoverable bytes', async () => {
    const f = await fixture()
    f.write('growing.txt', 'small original that must not be retained as a partial proof\n')
    f.baseCommit = f.commit()
    const large = Buffer.alloc(WORKSPACE_DIFF_MAX_BLOB_BYTES + 1, 76)
    f.write('growing.txt', large)
    f.write('tracked.txt', 'independent small change\n')
    const snapshot = await capture(f), evidence = review(snapshot), proofs = verifiedProofs(f, evidence)
    expect(evidence.reason).toBeNull()
    const file = evidence.files.find(file => file.path === 'growing.txt')!
    expect(file).toMatchObject({ status: 'modified', newSize: large.length })
    expect(proofs.has(file.oldBlob!)).toBe(false)
    expect(proofs.has(file.newBlob!)).toBe(false)
    const small = evidence.files.find(file => file.path === 'tracked.txt')!
    expect(proofs.get(small.newBlob!)!.toString()).toBe('independent small change\n')
    expect(snapshot.checkpoint.unavailableReason).toBeUndefined()
    expect(() => assertCheckpointFresh(snapshot.checkpoint)).not.toThrow()
    const restored = restoredWorktree(f)
    expect(await applyCheckpoint({ repoPath: f.repoPath, worktree: restored, checkpoint: snapshot.checkpoint })).toBe(true)
    expect(readFileSync(join(restored, 'growing.txt')).equals(large)).toBe(true)
  })

  it('refuses a complete proof set over four MiB without dropping the valid independent recovery patch', async () => {
    const f = await fixture(), bytes = 450 * 1024
    for (let index = 0; index < 5; index++) f.write(`bulk-${index}.txt`, Buffer.alloc(bytes, 65 + index))
    f.baseCommit = f.commit()
    for (let index = 0; index < 5; index++) f.write(`bulk-${index}.txt`, Buffer.alloc(bytes, 75 + index))
    expect(bytes * 10).toBeGreaterThan(CHECKPOINT_REVIEW_MAX_PROOF_BYTES)
    expect(bytes).toBeLessThan(WORKSPACE_DIFF_MAX_BLOB_BYTES)
    const snapshot = await capture(f), evidence = review(snapshot)
    expect(evidence).toMatchObject({ reason: 'too_large', files: [], blobs: [] })
    expect(snapshot.checkpoint.files).toBe(5)
    expect(snapshot.checkpoint.unavailableReason).toBeUndefined()
    expect(() => assertCheckpointFresh(snapshot.checkpoint)).not.toThrow()
    const restored = restoredWorktree(f)
    expect(await applyCheckpoint({ repoPath: f.repoPath, worktree: restored, checkpoint: snapshot.checkpoint })).toBe(true)
    for (let index = 0; index < 5; index++) expect(readFileSync(join(restored, `bulk-${index}.txt`)).equals(Buffer.alloc(bytes, 75 + index))).toBe(true)
  })

  it('reports a changed HEAD during the native snapshot as unavailable review while preserving recovery', async () => {
    const f = await fixture(), { script, counter } = installFilter(f)
    const nextHead = git(f.worktree, 'commit-tree', git(f.worktree, 'rev-parse', 'HEAD^{tree}'), '-p', f.baseCommit, '-m', 'HEAD changed during snapshot')
    writeFileSync(script, readFileSync(script, 'utf8').replace('process.stdout.write',
      `execFileSync('git', ['update-ref', 'HEAD', ${JSON.stringify(nextHead)}], { stdio: ['ignore', 'pipe', 'pipe'] });\nprocess.stdout.write`))
    f.write('filtered.txt', 'recover the tree even when HEAD races\n')
    const snapshot = await capture(f), evidence = review(snapshot)
    expect(readFileSync(counter, 'utf8')).toMatch(/^(clean\n)+$/)
    expect(git(f.worktree, 'rev-parse', 'HEAD')).toBe(nextHead)
    expect(snapshot.head).toBeNull()
    expect(evidence).toMatchObject({ revision: { headSha: null }, reason: 'version_changed', files: [], blobs: [] })
    expect(snapshot.checkpoint.unavailableReason).toBeUndefined()
    git(f.repoPath, 'config', 'filter.checkpoint-review.clean', 'cat')
    const restored = restoredWorktree(f)
    expect(await applyCheckpoint({ repoPath: f.repoPath, worktree: restored, checkpoint: snapshot.checkpoint })).toBe(true)
    expect(readFileSync(join(restored, 'filtered.txt'), 'utf8')).toBe('recover the tree even when HEAD races\n')
  })

  it.skipIf(process.platform === 'win32')('retains symlinks as unavailable metadata without reading or proving their target', async () => {
    const f = await fixture(), external = join(f.directory, 'outside-private.txt'), sentinel = `outside-fixture-${randomUUID()}`
    writeFileSync(external, sentinel)
    symlinkSync(external, join(f.worktree, 'outside-link'))
    const snapshot = await capture(f), evidence = review(snapshot)
    expect(evidence.reason).toBeNull()
    expect(evidence.files).toHaveLength(1)
    expect(evidence.files[0]).toMatchObject({ path: 'outside-link', status: 'unavailable', newMode: '120000', unavailableReason: 'file_type' })
    expect(evidence.blobs).toEqual([])
    expect(JSON.stringify(evidence)).not.toContain(sentinel)
    expect(JSON.stringify(evidence)).not.toContain(external)
    expect(existsSync(external)).toBe(true)
    expect(readFileSync(external, 'utf8')).toBe(sentinel)
  })
})
