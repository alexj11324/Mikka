import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, expect, it, vi } from 'vitest'
import type { RunCheckpoint, RunCompletion, StopReason } from '@mikka/protocol'
import type { AgentAdapter, AgentEvent, ExitEvent, StartOptions } from '../src/adapters/types'
import { createLogger } from '../src/log'
import type { OutboxItem } from '../src/outbox'
import { RunJournal } from '../src/runs/journal'
import { RunSupervisor, type SupervisorDeps } from '../src/runs/supervisor'
import { WorktreeManager } from '../src/worktrees'
import { cleanupTempDirs, makeRepo, tempDir } from './helpers'

afterEach(() => { vi.restoreAllMocks(); cleanupTempDirs() })

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

async function fixture(exit: ExitEvent = { type: 'exit', outcome: 'succeeded', stopReason: 'asked_human' },
  events?: () => AsyncIterable<AgentEvent>, finishing?: Pick<SupervisorDeps, 'captures'>) {
  const root = tempDir(), repo = await makeRepo(), runId = 'terminal-run'
  const journal = new RunJournal(join(root, 'journal.json'))
  const entered = deferred<StartOptions>(), release = deferred()
  const order: string[] = [], saved: RunCheckpoint[] = []
  let completion: RunCompletion | undefined
  const adapter: AgentAdapter = { harness: 'mock', capabilities: { supportsInterject: false, supportsResume: false }, envAllow: [],
    async start(options) {
      entered.resolve(options)
      await release.promise
      return { sessionId: 'session', events: events ?? (async function* () { yield exit }), async cancel() {}, async send() {} }
    }, async resume() { throw Error('Unexpected resume') },
  }
  const save = vi.fn<NonNullable<SupervisorDeps['saveCheckpoint']>>(async (_id, checkpoint) => {
    saved.push(checkpoint)
    order.push('checkpoint confirmed')
  })
  const supervisor = new RunSupervisor({ journal, log: createLogger({ level: 'silent' }),
    worktrees: new WorktreeManager(join(root, 'worktrees')), adapters: new Map([['mock', adapter]]),
    repository: () => ({ repoId: 'repo', name: 'fixture', path: repo }),
    baseRef: async () => 'main', prepareRepository: async () => {}, saveCheckpoint: save, cancelGraceMs: 10, ...finishing,
    outbox: { push(_id: string, item: OutboxItem) {
      if (item.kind === 'complete') { completion = item.completion; order.push('complete') }
    }, async compact() {}, lastChunkSeq() { return 0 } } as unknown as SupervisorDeps['outbox'],
  })
  supervisor.start({ runId, deviceId: 'device', issueId: 'issue', repoId: 'repo', harness: 'mock', prompt: 'work',
    leaseExpiresAt: new Date(Date.now() + 600_000).toISOString() })
  return { supervisor, runId, entered, release, saved, save, order, completion: () => completion }
}

const stops: StopReason[] = ['asked_human', 'blocked', 'submitted', 'turn_ended', 'error']
it.each(stops)('uploads the final workspace before %s releases its lease', async stopReason => {
  const f = await fixture({ type: 'exit', outcome: 'succeeded', stopReason, report: {
    // Runtime input can contain fields excluded by the TypeScript contract.
    safePoint: { session: 'exited', checkpoint: 'ready', checkpointTakenAt: '2020-01-01T00:00:00.000Z', observedAt: '2020-01-01T00:00:00.000Z' },
  } as ExitEvent['report'] })
  try {
    const start = await f.entered.promise
    writeFileSync(join(start.cwd, 'draft.txt'), 'final work before waiting\n')
    f.release.resolve()
    await f.supervisor.idle()
    expect(f.order).toEqual(['checkpoint confirmed', 'complete'])
    expect(f.completion()?.stopReason).toBe(stopReason)
    expect(f.saved[0]?.files).toBe(1)
    expect(gunzipSync(Buffer.from(f.saved[0]!.patch, 'base64')).toString()).toContain('final work before waiting')
    expect(f.completion()?.report.safePoint).toEqual({
      session: 'exited', checkpoint: 'ready', checkpointTakenAt: f.saved[0]!.takenAt, observedAt: expect.any(String),
    })
    expect(Date.parse(f.completion()!.report.safePoint!.observedAt)).toBeGreaterThanOrEqual(Date.parse(f.saved[0]!.takenAt))
  } finally { f.release.resolve(); await f.supervisor.stop() }
})

it('does not replace an unavailable final upload with an older heartbeat', async () => {
  const f = await fixture()
  try {
    const start = await f.entered.promise
    writeFileSync(join(start.cwd, 'draft.txt'), 'old checkpoint\n')
    await f.supervisor.saveCheckpoints(f.save, Date.now() + 180_000)
    writeFileSync(join(start.cwd, 'draft.txt'), 'unique unbacked work\n')
    f.save.mockRejectedValueOnce(new Error('Final checkpoint upload refused'))
    f.release.resolve()
    await f.supervisor.idle()
    expect(f.save).toHaveBeenCalledTimes(2)
    expect(f.completion()?.report.safePoint).toEqual({ session: 'exited', checkpoint: 'unavailable', observedAt: expect.any(String) })
    expect(gunzipSync(Buffer.from(f.saved[0]!.patch, 'base64')).toString()).toContain('old checkpoint')
    expect(readFileSync(join(start.cwd, 'draft.txt'), 'utf8')).toBe('unique unbacked work\n')
  } finally { f.release.resolve(); await f.supervisor.stop() }
})

it('cannot report completion before the final upload has been acknowledged', async () => {
  const f = await fixture(), uploading = deferred(), uploaded = deferred()
  f.save.mockImplementationOnce(async (_id, snapshot) => {
    uploading.resolve()
    await uploaded.promise
    f.saved.push(snapshot)
  })
  try {
    await f.entered.promise
    f.release.resolve()
    await uploading.promise
    expect(f.completion()).toBeUndefined()
    expect(f.supervisor.get(f.runId).state).toBe('running')
    // A heartbeat during finishing cannot overwrite the final snapshot.
    await f.supervisor.saveCheckpoints(f.save, Date.now() + 180_000)
    expect(f.save).toHaveBeenCalledTimes(1)
    uploaded.resolve()
    await f.supervisor.idle()
    expect(f.completion()?.report.safePoint?.checkpointTakenAt).toBe(f.saved[0]?.takenAt)
    expect(f.saved[0]?.files).toBe(0)
  } finally { f.release.resolve(); uploaded.resolve(); await f.supervisor.stop() }
})

it('does not turn an exhausted stream into a confirmed session exit', async () => {
  const f = await fixture(undefined, async function* () {})
  try {
    await f.entered.promise
    f.release.resolve()
    await f.supervisor.idle()
    expect(f.completion()?.stopReason).toBe('error')
    expect(f.completion()?.report.safePoint).toBeUndefined()
  } finally { f.release.resolve(); await f.supervisor.stop() }
})

it('does not certify an adapter error without a confirmed native exit', async () => {
  const f = await fixture({ type: 'exit', outcome: 'failed', sessionExited: false })
  try {
    await f.entered.promise
    f.release.resolve()
    await f.supervisor.idle()
    expect(f.completion()?.stopReason).toBe('error')
    expect(f.completion()?.report.safePoint).toBeUndefined()
  } finally { f.release.resolve(); await f.supervisor.stop() }
})

it('does not certify retirement when capture upload fails after the CLI exits', async () => {
  const f = await fixture(undefined, undefined, { captures: { async flush() { throw Error('Capture upload refused') } } })
  try {
    await f.entered.promise
    f.release.resolve()
    await f.supervisor.idle()
    expect(f.completion()?.stopReason).toBe('error')
    expect(f.completion()?.report.safePoint).toBeUndefined()
    // Preserve the workspace even though the remaining artifact is not durable.
    expect(f.save).toHaveBeenCalledOnce()
  } finally { f.release.resolve(); await f.supervisor.stop() }
})

it('does not certify a session detached after ignoring cancellation', async () => {
  const waiting = deferred(), end = deferred()
  const f = await fixture(undefined, async function* () { waiting.resolve(); await end.promise })
  try {
    await f.entered.promise
    f.release.resolve()
    await waiting.promise
    await f.supervisor.cancel(f.runId)
    await f.supervisor.idle()
    expect(f.completion()?.stopReason).toBe('cancelled')
    expect(f.completion()?.report.safePoint).toBeUndefined()
    expect(f.save).not.toHaveBeenCalled()
  } finally { f.release.resolve(); end.resolve(); await f.supervisor.stop() }
})
