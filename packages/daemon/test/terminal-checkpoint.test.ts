import { appendFileSync, existsSync, readFileSync, readdirSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, expect, it, vi } from 'vitest'
import type { RunCheckpoint, RunCheckpointReceipt, RunCompletion, StopReason } from '@mikka/protocol'
import type { AgentAdapter, AgentEvent, ExitEvent, StartOptions } from '../src/adapters/types'
import { CaptureUploader } from '../src/captures'
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

async function fixture(exit: ExitEvent = { type: 'exit', outcome: 'succeeded', stopReason: 'asked_human' },
  events?: () => AsyncIterable<AgentEvent>, finishing?: Pick<SupervisorDeps, 'captures' | 'publisher'>) {
  const root = tempDir(), repo = await makeRepo(), runId = 'terminal-run'
  const journal = new RunJournal(join(root, 'journal.json'))
  const entered = deferred<StartOptions>(), release = deferred()
  const order: string[] = [], saved: RunCheckpoint[] = [], receipts: RunCheckpointReceipt[] = []
  let completion: RunCompletion | undefined
  const adapter: AgentAdapter = { harness: 'mock', capabilities: { supportsInterject: false, supportsResume: false }, envAllow: [],
    async start(options) {
      entered.resolve(options)
      await release.promise
      return { sessionId: 'session', events: events ?? (async function* () { yield exit }), async cancel() {}, async send() {} }
    }, async resume() { throw Error('Unexpected resume') },
  }
  const acknowledge = (id: string, checkpoint: RunCheckpoint): RunCheckpointReceipt => {
    saved.push(checkpoint)
    order.push('checkpoint confirmed')
    // The server upload clock is independent of the daemon's capture clock.
    const receipt = { runId: id, takenAt: '2026-01-02T03:04:05.678Z' }
    receipts.push(receipt)
    return receipt
  }
  const save = vi.fn<NonNullable<SupervisorDeps['saveCheckpoint']>>(async (id, checkpoint) => acknowledge(id, checkpoint))
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
  return { supervisor, runId, entered, release, saved, receipts, acknowledge, save, order, completion: () => completion }
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
    expect(f.saved[0]!.takenAt).not.toBe(f.receipts[0]!.takenAt)
    expect(f.completion()?.report.safePoint).toEqual({
      session: 'exited', checkpoint: 'ready', checkpointTakenAt: f.receipts[0]!.takenAt, observedAt: f.receipts[0]!.takenAt,
    })
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
  f.save.mockImplementationOnce(async (id, snapshot) => {
    uploading.resolve()
    await uploaded.promise
    return f.acknowledge(id, snapshot)
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
    expect(f.completion()?.report.safePoint?.checkpointTakenAt).toBe(f.receipts[0]?.takenAt)
    expect(f.saved[0]?.files).toBe(0)
  } finally { f.release.resolve(); uploaded.resolve(); await f.supervisor.stop() }
})

it('a legacy upload acknowledgement without a server receipt cannot certify retirement', async () => {
  const f = await fixture()
  try {
    const start = await f.entered.promise
    writeFileSync(join(start.cwd, 'draft.txt'), 'retained without an acknowledged snapshot identity\n')
    // Older servers return 204: the bytes may be stored, but the daemon does
    // not know the authoritative snapshot time that automatic retirement uses.
    f.save.mockResolvedValueOnce(undefined)
    f.release.resolve()
    await f.supervisor.idle()
    expect(f.save).toHaveBeenCalledOnce()
    expect(f.completion()?.report.safePoint).toEqual({
      session: 'exited', checkpoint: 'unavailable', observedAt: expect.any(String),
    })
    expect(readFileSync(join(start.cwd, 'draft.txt'), 'utf8')).toBe('retained without an acknowledged snapshot identity\n')
  } finally { f.release.resolve(); await f.supervisor.stop() }
})

it.each([
  ['another run', { runId: 'different-run', takenAt: '2026-01-02T03:04:05.678Z' }],
  ['invalid server time', { runId: 'terminal-run', takenAt: 'not-a-time' }],
  ['noncanonical server time', { runId: 'terminal-run', takenAt: '2026-01-02T03:04:05.678+00:00' }],
  ['unknown receipt fields', { runId: 'terminal-run', takenAt: '2026-01-02T03:04:05.678Z', unverified: true }],
] as const)('does not certify retirement from %s in an upload receipt', async (_reason, receipt) => {
  const f = await fixture()
  try {
    await f.entered.promise
    // Deliberately malformed runtime input bypasses the TypeScript transport contract.
    f.save.mockResolvedValueOnce(receipt as unknown as RunCheckpointReceipt)
    f.release.resolve()
    await f.supervisor.idle()
    expect(f.completion()?.report.safePoint).toEqual({
      session: 'exited', checkpoint: 'unavailable', observedAt: expect.any(String),
    })
  } finally { f.release.resolve(); await f.supervisor.stop() }
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

it('cancels capture work at the final deadline and waits for cleanup before reporting completion', async () => {
  const uploading = deferred(), cleanup = deferred()
  let uploadSignal: AbortSignal | undefined
  let expire: (() => void) | undefined
  const schedule = setTimeout
  const f = await fixture(undefined, undefined, { captures: { async flush(_runId, _existingOnly, signal) {
    uploadSignal = signal
    uploading.resolve()
    await cleanup.promise
    signal?.throwIfAborted()
  } } })
  try {
    await f.entered.promise
    // Capture only the final budget; git and the run's other I/O keep real timers.
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      if (delay === 60_000) expire = () => callback(...args)
      return schedule(callback, delay, ...args)
    })
    f.release.resolve()
    await uploading.promise
    expect(expire).toBeDefined()
    expire!()
    await Promise.resolve()
    expect(uploadSignal?.aborted).toBe(true)
    expect(f.completion()).toBeUndefined()
    expect(f.save).not.toHaveBeenCalled()
    timer.mockRestore()
    cleanup.resolve()
    await f.supervisor.idle()
    expect(f.completion()?.stopReason).toBe('error')
    expect(f.completion()?.report.summary).toBe('Capture finalization deadline exceeded')
    expect(f.completion()?.report.safePoint).toBeUndefined()
  } finally { f.release.resolve(); cleanup.resolve(); await f.supervisor.stop() }
})

it('drains real video preparation after report failure before an error completion can close the upload fence', async () => {
  const dir = tempDir('capture-report-error-'), pending = tempDir('capture-report-error-pending-')
  const id = '00000000-0000-4000-8000-000000000001', source = join(dir, `${id}.mp4`)
  const bytes = readFileSync(new URL('../../../tests/fixtures/factory-visual-evidence.mp4', import.meta.url))
  writeFileSync(source, bytes)
  const atomSize = 200_000_001, header = Buffer.alloc(8)
  header.writeUInt32BE(atomSize); header.write('free', 4)
  appendFileSync(source, header); truncateSync(source, bytes.length + atomSize)
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ title: 'Synthetic cancellation fixture' }))
  const begin = vi.fn(async () => ({ captureId: id, upload: { target: 'server' as const } }))
  const uploader = new CaptureUploader(() => dir, {
    beginCapture: begin, sendCapture: async () => undefined, completeCapture: async () => ({} as never),
  }, createLogger({ level: 'silent' }), pending)
  const flush = vi.spyOn(uploader, 'flush'), pendingDir = join(pending, 'terminal-run')
  const snapshot = vi.fn(async () => { throw new Error('Report snapshot failed') })
  const f = await fixture(undefined, async function* () {
    yield { type: 'chunk', chunk: { type: 'tool-output-available', toolCallId: 'capture', output: 'queued' } }
    await waitFor(() => existsSync(pendingDir) && readdirSync(pendingDir).some(name => name.startsWith('.capture-process-')), 15_000, 1)
    yield { type: 'exit', outcome: 'succeeded', stopReason: 'submitted' }
  }, { captures: uploader, publisher: { snapshot, publish: async () => { throw new Error('Unexpected publication') } } })
  try {
    await f.entered.promise
    f.release.resolve()
    await f.supervisor.idle()
    await flush.mock.results[0]?.value
    expect(snapshot).toHaveBeenCalledOnce()
    expect(f.completion()?.stopReason).toBe('error')
    expect(f.completion()?.report.summary).toBe('Report snapshot failed')
    expect(f.completion()?.report.safePoint).toBeUndefined()
    expect(begin).not.toHaveBeenCalled()
    expect(existsSync(source)).toBe(true)
    expect(readdirSync(pendingDir)).toEqual([])
  } finally {
    f.release.resolve(); await f.supervisor.stop()
    await Promise.all(flush.mock.results.map(result => result.value?.catch(() => undefined)))
  }
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
