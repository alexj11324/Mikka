import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { execa } from 'execa'
import { afterEach, expect, it, vi } from 'vitest'
import type { RunAssignment, RunCompletion } from '@mikka/protocol'
import type { AgentAdapter } from '../src/adapters/types'
import { agentPublishedReceipt } from '../src/agents/github-runtime'
import { publishRun, snapshotTree } from '../src/agents/publish'
import { createLogger } from '../src/log'
import type { OutboxItem } from '../src/outbox'
import { RunJournal } from '../src/runs/journal'
import { RunSupervisor, type SupervisorDeps } from '../src/runs/supervisor'
import { WorktreeManager } from '../src/worktrees'
import { cleanupTempDirs, makeRepo, tempDir, waitFor } from './helpers'

afterEach(() => { vi.restoreAllMocks(); cleanupTempDirs() })

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

type Phase = 'report' | 'before_verify' | 'verify' | 'after_verify' | 'publish' | 'captures'

async function fixture(phase: Phase) {
  const root = tempDir(), repo = await makeRepo(), origin = join(root, 'origin.git')
  await execa('git', ['init', '-q', '--bare', origin])
  await execa('git', ['remote', 'add', 'origin', origin], { cwd: repo })
  const journal = new RunJournal(join(root, 'journal.json')), worktrees = new WorktreeManager(join(root, 'worktrees'))
  const entered = deferred<AbortSignal | undefined>(), release = deferred()
  const pause = async (at: Phase, signal?: AbortSignal) => {
    if (at === phase) { entered.resolve(signal); await release.promise }
  }
  const originalChangedFiles = worktrees.changedFiles.bind(worktrees)
  vi.spyOn(worktrees, 'changedFiles').mockImplementation(async (...args) => {
    await pause('report')
    return originalChangedFiles(...args)
  })
  const adapter: AgentAdapter = { harness: 'mock', capabilities: { supportsInterject: false, supportsResume: false }, envAllow: [],
    async start(options) {
      writeFileSync(join(options.cwd, 'delivery.txt'), 'Verified delivery\n')
      return { sessionId: 'session', async *events() {
        yield { type: 'exit' as const, outcome: 'succeeded' as const, stopReason: 'submitted' as const, report: { summary: 'Ready' } }
      }, async cancel() {}, async send() {} }
    }, async resume() { throw Error('Unexpected resume') },
  }
  let snapshots = 0, completion: RunCompletion | undefined
  const close = vi.fn(), verify = vi.fn<NonNullable<SupervisorDeps['verify']>>(async ({ signal }) => {
    await pause('verify', signal)
    return { exitCode: 0, signal: null, timedOut: false, output: 'Verified' }
  })
  const publish = vi.fn<NonNullable<SupervisorDeps['publisher']>['publish']>(async ({ runId, worktree, tree, signal }) => {
    await pause('publish', signal)
    return publishRun({ runId, repoPath: repo, worktree, tree, summary: 'Ready', issueId: 'issue',
      pushBranch: 'mikka/task', push: { approved: true, remote: 'origin' }, signal })
  })
  const supervisor = new RunSupervisor({ journal, worktrees, log: createLogger({ level: 'silent' }),
    outbox: { push(_runId: string, item: OutboxItem) { if (item.kind === 'complete') completion = item.completion },
      async compact() {}, lastChunkSeq() { return 0 } } as unknown as SupervisorDeps['outbox'],
    adapters: new Map([['mock', adapter]]), repository: () => ({ repoId: 'repo', name: 'fixture', path: repo }),
    baseRef: async () => 'main', prepareRepository: async () => {},
    prepareRunGitHub: async () => ({ env: {}, close }), verify,
    publisher: { snapshot: async ({ worktree, signal }) => {
      await pause(++snapshots === 1 ? 'before_verify' : 'after_verify', signal)
      return snapshotTree(repo, worktree, undefined, signal)
    }, publish },
    captures: { flush: () => pause('captures') },
  })
  const assignment: RunAssignment = { runId: 'finishing-run', deviceId: 'device', issueId: 'issue', repoId: 'repo',
    harness: 'mock', prompt: 'Deliver the change', verifyCommand: 'true', leaseExpiresAt: new Date(Date.now() + 600_000).toISOString() }
  supervisor.start(assignment)
  return { supervisor, runId: assignment.runId, origin, entered, release, close, verify, publish, completion: () => completion }
}

it.each<Phase>(['report', 'before_verify', 'verify', 'after_verify', 'publish'])('cancels during %s without creating an external branch', async phase => {
  const f = await fixture(phase)
  try {
    const signal = await f.entered.promise
    const cancellation = f.supervisor.cancel(f.runId)
    // No CLI grace period covers host work after the exit event.
    if (signal) expect(signal.aborted).toBe(true)
    f.release.resolve()
    await cancellation
    await f.supervisor.idle()
    expect(f.supervisor.get(f.runId)).toMatchObject({ state: 'cancelled', stopReason: 'cancelled' })
    if (phase !== 'publish') expect(f.publish).not.toHaveBeenCalled()
    if (phase === 'report' || phase === 'before_verify') expect(f.verify).not.toHaveBeenCalled()
    expect((await execa('git', ['--git-dir', f.origin, 'for-each-ref', '--format=%(refname)'])).stdout).toBe('')
    expect(f.completion()?.report.publish?.pushed).not.toBe(true)
    expect(f.close).toHaveBeenCalledOnce()
  } finally { f.release.resolve(); await f.supervisor.stop() }
})

it.each(['revoke', 'expiry'] as const)('honors local lease %s after verification waits and prevents publication', async reason => {
  const f = await fixture('verify')
  try {
    const signal = await f.entered.promise
    if (reason === 'revoke') {
      f.supervisor.revokeLeases([f.runId])
      expect(signal?.aborted).toBe(true)
    } else f.supervisor.renewLeases({ [f.runId]: new Date(Date.now() - 1).toISOString() })
    f.release.resolve()
    await f.supervisor.idle()
    expect(signal?.aborted).toBe(true)
    expect(f.completion()?.stopReason).toBe('device_lost')
    expect(f.publish).not.toHaveBeenCalled()
    expect(f.close).toHaveBeenCalledOnce()
  } finally { f.release.resolve(); await f.supervisor.stop() }
})

it('keeps a late pushed stop authoritative while the successful receipt waits for captures', async () => {
  const f = await fixture('captures')
  try {
    await f.entered.promise
    expect(f.publish).toHaveBeenCalledOnce()
    const cancellation = f.supervisor.cancel(f.runId)
    f.release.resolve()
    await cancellation
    // A completed push stays an honest receipt, but does not undo the stop.
    expect(f.completion()).toMatchObject({ stopReason: 'cancelled', report: { publish: { pushed: true } } })
    expect(f.close).toHaveBeenCalledOnce()
  } finally { f.release.resolve(); await f.supervisor.stop() }
})

async function worktreeFixture() {
  const root = tempDir(), repo = await makeRepo(), worktree = join(root, 'worktree'), bin = join(root, 'bin')
  mkdirSync(bin)
  await execa('git', ['worktree', 'add', '-q', '-b', 'mikka/run-process-cancel', worktree], { cwd: repo })
  const signal = new AbortController()
  return { root, repo, worktree, bin, signal, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` } }
}

/** A real executable with an observable SIGTERM handler, and no network IO. */
function waitingExecutable(path: string, events: string, kind: string) {
  writeFileSync(path, `#!${process.execPath}\nconst fs = require('node:fs')\nconst file = ${JSON.stringify(events)}\nconst kind = ${kind}\nprocess.on('SIGTERM', () => { fs.appendFileSync(file, kind + ':stopped\\n'); process.exit(0) })\nfs.appendFileSync(file, kind + ':started\\n')\nsetInterval(() => {}, 1000)\n`, { mode: 0o700 })
}

it('terminates an in-flight Git push and its real remote helper on local abort', async () => {
  const f = await worktreeFixture(), events = join(f.root, 'git-events')
  waitingExecutable(join(f.bin, 'git-remote-cancel'), events, "'git'")
  await execa('git', ['remote', 'add', 'origin', 'cancel::fixture'], { cwd: f.repo })
  writeFileSync(join(f.worktree, 'delivery.txt'), 'Delivery\n')
  const publication = publishRun({ runId: 'process-cancel', repoPath: f.repo, worktree: f.worktree,
    tree: await snapshotTree(f.repo, f.worktree), summary: 'Ready', issueId: 'issue', push: { approved: true, remote: 'origin' },
    signal: f.signal.signal, env: { ...f.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.cancel.allow', GIT_CONFIG_VALUE_0: 'always' } })
  void publication.catch(() => undefined)
  try {
    await waitFor(() => existsSync(events) && readFileSync(events, 'utf8').includes('git:started'))
    f.signal.abort()
    await expect(publication).rejects.toMatchObject({ name: 'AbortError' })
    expect(readFileSync(events, 'utf8')).toContain('git:stopped')
  } finally { f.signal.abort(); await publication.catch(() => undefined) }
})

it('aborts both real gh receipt children before removing their credential directory', async () => {
  const f = await worktreeFixture(), events = join(f.root, 'gh-events'), origin = join(f.root, 'origin.git')
  await execa('git', ['init', '-q', '--bare', origin])
  await execa('git', ['push', origin, 'HEAD:refs/heads/mikka/task'], { cwd: f.worktree })
  const config = join(f.root, 'gitconfig')
  await execa('git', ['config', '--file', config, `url.${origin}.insteadOf`, 'https://github.com/owner/repo.git'])
  waitingExecutable(join(f.bin, 'gh'), events, 'process.argv[2]')
  const privateDir = join(f.root, 'receipt')
  const receipt = agentPublishedReceipt({ runId: 'process-cancel', repoPath: f.repo, worktree: f.worktree,
    tree: await snapshotTree(f.repo, f.worktree), hosted: true, privateDir,
    github: { endpoint: 'https://mikka.invalid/api/runs/github-token', repository: 'owner/repo', branch: 'mikka/task', issueId: 'issue' },
    signal: f.signal.signal, env: { ...f.env, GIT_CONFIG_GLOBAL: config } })
  void receipt.catch(() => undefined)
  try {
    await waitFor(() => existsSync(events) && readFileSync(events, 'utf8').split(':started').length === 3)
    f.signal.abort()
    await expect(receipt).rejects.toMatchObject({ name: 'AbortError' })
    expect(readFileSync(events, 'utf8')).toContain('pr:stopped')
    expect(readFileSync(events, 'utf8')).toContain('api:stopped')
    expect(readdirSync(privateDir)).toEqual([])
  } finally { f.signal.abort(); await receipt.catch(() => undefined) }
})
