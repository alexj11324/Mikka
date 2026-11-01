import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ execa: vi.fn(), git: vi.fn(), pinnedGit: vi.fn(), snapshotTree: vi.fn() }))
vi.mock('execa', () => ({ execa: mocks.execa }))
vi.mock('../src/agents/publish', async importOriginal => ({
  ...await importOriginal<typeof import('../src/agents/publish')>(),
  pinnedGit: mocks.pinnedGit,
  snapshotTree: mocks.snapshotTree,
}))

import { agentPublishedReceipt } from '../src/agents/github-runtime'

type Read = 'commit' | 'pr' | 'ci'
type Output = { stdout: string }
const commit = 'b'.repeat(40), originalHead = 'a'.repeat(40), tree = 'c'.repeat(40)
const github = { endpoint: 'https://mikka.example/api/runs/github-token', repository: 'owner/repo', branch: 'mikka/task', runToken: 'synthetic-run-token', issueId: '10000000-0000-4000-8000-000000000001' }
const receiptError = 'The task pull request and successful CI must match the submitted commit'
const cleanups: Array<() => Promise<void>> = []
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve))

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.resetAllMocks()
})

function fixture(hosted = true, importFailure?: Error) {
  const root = mkdtempSync(join(tmpdir(), 'mikka-receipt-concurrency-'))
  const bin = join(root, 'bin'), worktree = join(root, 'worktree')
  mkdirSync(bin); mkdirSync(worktree)
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nexit 99\n', { mode: 0o700 })
  const reads = { commit: deferred<Output>(), pr: deferred<Output>(), ci: deferred<Output>() }
  const valid: Record<Read, string> = {
    commit: JSON.stringify({ sha: commit, tree: { sha: tree } }),
    pr: JSON.stringify({ headRefOid: commit, body: `Verified\n<!-- mikka-issue:${github.issueId} -->` }),
    ci: JSON.stringify({ data: { repository: { object: { oid: commit, statusCheckRollup: { state: 'SUCCESS' } } } } }),
  }
  const remote = deferred<Output>(), remoteRequested = deferred<void>()
  const started: Read[] = []
  let receiptDirectory = ''
  mocks.pinnedGit.mockResolvedValue(mocks.git)
  mocks.snapshotTree.mockResolvedValue(tree)
  mocks.git.mockImplementation(async (args: string[]) => {
    if (args[0] === 'ls-remote') { remoteRequested.resolve(); return remote.promise }
    if (args[0] === 'rev-parse') return { stdout: args[1] === 'HEAD^{tree}' ? tree : hosted ? originalHead : commit }
    if (args[0] === 'fetch' && importFailure) throw importFailure
    return { stdout: '' }
  })
  mocks.execa.mockImplementation((binary: string, args: string[]) => {
    receiptDirectory = dirname(dirname(dirname(binary)))
    const kind: Read = args[0] === 'pr' ? 'pr' : args[1] === 'graphql' ? 'ci' : 'commit'
    if (kind === 'commit') expect(args).toEqual(['api', `repos/${github.repository}/git/commits/${commit}`])
    if (kind === 'ci') expect(args).toContain(`commit=${commit}`)
    started.push(kind)
    return reads[kind].promise
  })
  const receipt = agentPublishedReceipt({ runId: 'receipt-test', repoPath: join(root, 'repo'), worktree,
    tree, github, privateDir: join(root, 'private'), hosted, env: { NODE_ENV: 'test', PATH: bin } })
  void receipt.catch(() => undefined)
  const release = (kind: Read, value = valid[kind]) => reads[kind].resolve({ stdout: value })
  const mutations = () => mocks.git.mock.calls.map(([args]) => args as string[])
    .filter(args => ['fetch', 'update-ref', 'read-tree'].includes(args[0]))
  cleanups.push(async () => {
    remote.resolve({ stdout: `${commit}\trefs/heads/${github.branch}` })
    for (const kind of ['commit', 'pr', 'ci'] as const) release(kind)
    await receipt.catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  })
  return { hosted, reads, remote, remoteRequested, started, receipt, release, mutations, directory: () => receiptDirectory }
}

async function beginReads(f: ReturnType<typeof fixture>) {
  await f.remoteRequested.promise
  expect(f.started).toEqual([])
  f.remote.resolve({ stdout: `${commit}\trefs/heads/${github.branch}` })
  await nextTurn()
  expect([...f.started].sort()).toEqual(f.hosted ? ['ci', 'commit', 'pr'] : ['ci', 'pr'])
  expect(f.mutations()).toEqual([])
}

it('starts all hosted receipt reads together and imports only after every read validates', async () => {
  const f = fixture()
  await beginReads(f)
  f.release('ci'); f.release('commit')
  await nextTurn()
  expect(f.mutations()).toEqual([])
  f.release('pr')
  await expect(f.receipt).resolves.toEqual({ branch: github.branch, commit, pushed: true, remote: 'origin' })
  expect(f.mutations()).toEqual([
    ['fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', 'https://github.com/owner/repo.git', commit],
    ['update-ref', 'refs/heads/mikka/run-receipt-test', commit, originalHead],
    ['read-tree', commit],
  ])
  expect(existsSync(f.directory())).toBe(false)
})

it.each([
  ['commit', JSON.stringify({ sha: originalHead, tree: { sha: tree } })],
  ['commit', JSON.stringify({ sha: commit, tree: { sha: originalHead } })],
  ['pr', JSON.stringify({ headRefOid: originalHead, body: `<!-- mikka-issue:${github.issueId} -->` })],
  ['pr', JSON.stringify({ headRefOid: commit, body: 'Unbound issue' })],
  ['ci', JSON.stringify({ data: { repository: { object: { oid: originalHead, statusCheckRollup: { state: 'SUCCESS' } } } } })],
  ['ci', JSON.stringify({ data: { repository: { object: { oid: commit, statusCheckRollup: { state: 'PENDING' } } } } })],
  ['pr', 'not JSON'],
] as const)('refuses an invalid %s receipt without importing or changing refs', async (kind, output) => {
  const f = fixture()
  await beginReads(f)
  for (const read of ['commit', 'pr', 'ci'] as const) f.release(read, read === kind ? output : undefined)
  await expect(f.receipt).rejects.toThrow(receiptError)
  expect(f.mutations()).toEqual([])
})

it.each(['commit', 'pr', 'ci'] as const)('drains sibling reads before cleaning up after a rejected %s command', async kind => {
  const f = fixture()
  await beginReads(f)
  let settled = false
  void f.receipt.then(() => { settled = true }, () => { settled = true })
  f.reads[kind].reject(new Error('Synthetic gh failure'))
  await nextTurn()
  expect(settled).toBe(false)
  expect(existsSync(f.directory())).toBe(true)
  expect(f.mutations()).toEqual([])
  for (const read of ['commit', 'pr', 'ci'] as const) if (read !== kind) f.release(read)
  await expect(f.receipt).rejects.toThrow(receiptError)
  expect(f.mutations()).toEqual([])
  expect(existsSync(f.directory())).toBe(false)
})

it('runs non-hosted PR and CI reads together without a hosted commit request or import', async () => {
  const f = fixture(false)
  await beginReads(f)
  f.release('pr'); f.release('ci')
  await expect(f.receipt).resolves.toMatchObject({ commit, pushed: true })
  expect([...f.started].sort()).toEqual(['ci', 'pr'])
  expect(f.mutations()).toEqual([])
})

it('preserves the original Git import failure after successful receipt validation', async () => {
  const failure = new Error('Synthetic fetch failure'), f = fixture(true, failure)
  await beginReads(f)
  for (const read of ['commit', 'pr', 'ci'] as const) f.release(read)
  await expect(f.receipt).rejects.toBe(failure)
  expect(f.mutations().map(args => args[0])).toEqual(['fetch'])
  expect(existsSync(f.directory())).toBe(false)
})
