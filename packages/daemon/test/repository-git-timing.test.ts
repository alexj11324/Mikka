import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import type { RunAssignment } from '@mikka/protocol'
import { RepositoryCache } from '../src/repositories'
import { prepareRunRepository } from '../src/run-repository'
import { createRepositoryGitTimer, type RepositoryGitTiming } from '../src/repository-git-timing'
import { cleanupTempDirs, makeRepo, tempDir } from './helpers'

afterEach(cleanupTempDirs)

it('records actual fresh clone and cached fetch operations and leaves ordinary runs without a receipt', async () => {
  const root = tempDir(), repo = await makeRepo()
  const assignment = { runId: 'repository-receipt', issueId: 'issue', deviceId: 'device', repoId: 'repo', prompt: 'read', harness: 'claude_code', kind: 'plan',
    remoteUrl: pathToFileURL(repo).href } as RunAssignment
  const receipts: RepositoryGitTiming[] = []
  const cache = new RepositoryCache(join(root, 'cache'), true)
  const observer = (timing: RepositoryGitTiming) => { receipts.push(timing) }
  await prepareRunRepository(cache, join(root, 'private'), assignment, new AbortController().signal, undefined, undefined, undefined, observer)
  expect(receipts).toEqual([])
  await prepareRunRepository(cache, join(root, 'private'), { ...assignment, taskEnv: { CLOUD_STARTUP_TIMING: '1' } },
    new AbortController().signal, undefined, undefined, undefined, observer)
  expect(receipts).toHaveLength(1)
  expect(receipts[0]).toMatchObject({ source: 'prepare_run_repository', clock: 'repository_prepare_monotonic', outcome: 'ok', truncated: false })
  expect(receipts[0]!.phases.some(phase => phase.name === 'daemon.repository.git.fetch')).toBe(true)
  for (const phase of receipts[0]!.phases) {
    expect(phase.startMs).toBeGreaterThanOrEqual(0)
    expect(phase.endMs).toBeLessThanOrEqual(receipts[0]!.ms)
    expect(phase.ms).toBeCloseTo(phase.endMs - phase.startMs, 2)
  }
  await prepareRunRepository(new RepositoryCache(join(root, 'fresh-cache'), true), join(root, 'private'),
    { ...assignment, taskEnv: { CLOUD_STARTUP_TIMING: '1' } }, new AbortController().signal, undefined, undefined, undefined, observer)
  expect(receipts).toHaveLength(2)
  expect(receipts[1]!.phases.some(phase => phase.name === 'daemon.repository.git.clone')).toBe(true)
  expect(receipts[1]!.phases.some(phase => phase.name === 'daemon.repository.git.local')).toBe(true)
  expect(JSON.stringify(receipts)).not.toContain(repo)
})

it('keeps original errors and success when the diagnostic observer throws', async () => {
  const root = tempDir(), repo = await makeRepo()
  const assignment = { runId: 'repository-observer', issueId: 'issue', deviceId: 'device', repoId: 'repo', prompt: 'read', harness: 'claude_code', kind: 'plan',
    remoteUrl: pathToFileURL(repo).href, taskEnv: { CLOUD_STARTUP_TIMING: '1' } } as RunAssignment
  const cache = new RepositoryCache(join(root, 'cache'), true)
  const observer = () => { throw Error('synthetic diagnostic failure') }
  await expect(prepareRunRepository(cache, join(root, 'private'), assignment, new AbortController().signal,
    undefined, undefined, undefined, observer)).resolves.toBeUndefined()
  const abort = new AbortController(), reason = Error('original cancellation')
  abort.abort(reason)
  let receipt: RepositoryGitTiming | undefined
  await expect(prepareRunRepository(cache, join(root, 'private'), assignment, abort.signal, undefined, undefined, undefined,
    value => { receipt = value; observer() })).rejects.toBe(reason)
  expect(receipt?.outcome).toBe('error')
})

it('bounds receipts and isolates concurrent origins; close prevents later append', async () => {
  const first = createRepositoryGitTimer('a'.repeat(16), 'claude_code')
  const second = createRepositoryGitTimer('b'.repeat(16), 'codex')
  let release!: () => void
  const pending = first.measure('clone', () => new Promise<void>(resolve => { release = resolve }))
  for (let i = 0; i < 40; i++) await second.measure('local', async () => {})
  const a = first.finish('error'), b = second.finish('ok')
  release(); await pending
  expect(a.phases).toEqual([])
  expect(a.runIdHash).toBe('a'.repeat(16))
  expect(b.runIdHash).toBe('b'.repeat(16))
  expect(b.phases).toHaveLength(32)
  expect(b.truncated).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(b))).toBeLessThanOrEqual(8192)
})
