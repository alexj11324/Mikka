import { randomUUID } from 'node:crypto'
import { realpathSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { hostedBinaries } from '../src/hosted-binaries'
import { prefetchHostedCliFiles } from '../src/hosted-cli-prefetch'
import { createLogger } from '../src/log'
import { Daemon } from '../src/main'
import { RpcServer, type RpcHandlers, type RpcServerOptions } from '../src/rpc/server'
import { MemoryServer } from '../src/server-link'
import { cleanupTempDirs, tempDir } from './helpers'

const nativeStart = vi.hoisted(() => vi.fn(async () => {
  throw Error('No native task is authorized in this scheduling test')
}))
// These are daemon I/O scheduling tests, not execution/host admission tests.
// Keep the real resolver. A refused claim must never start a native adapter.
vi.mock('../src/subscription-hosted-runner', async original => {
  const actual = await original<typeof import('../src/subscription-hosted-runner')>()
  return { ...actual, createHostedBotRunner: async (host: Parameters<typeof actual.createHostedBotRunner>[0]) => ({
    binaries: hostedBinaries(host.binaries), harnesses: ['claude_code'],
    start: nativeStart, prepare: nativeStart, command: nativeStart,
  }) }
})
vi.mock('../src/hosted-cli-prefetch', async original => {
  const actual = await original<typeof import('../src/hosted-cli-prefetch')>()
  return { ...actual, prefetchHostedCliFiles: vi.fn(actual.prefetchHostedCliFiles) }
})
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})
const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
let handlers: RpcHandlers
const cleanups: (() => Promise<void>)[] = []
beforeEach(() => {
  vi.mocked(fs.open).mockReset().mockImplementation(actualFs.open)
  vi.mocked(prefetchHostedCliFiles).mockClear()
  nativeStart.mockClear()
  // The UI socket is unrelated to the server registration/claim ordering.
  vi.spyOn(RpcServer.prototype, 'listen').mockImplementation(async function (this: RpcServer) {
    handlers = (this as unknown as { options: RpcServerOptions }).options.handlers
  })
})
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0)) await cleanup() }
  finally { vi.restoreAllMocks(); cleanupTempDirs() }
})
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
function machine(cloud = true) {
  const binary = join(realpathSync(tempDir()), 'claude')
  writeFileSync(binary, Buffer.alloc(400_007, 61), { mode: 0o755 })
  const softwareReads: string[] = []
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    if (String(args[0]) === binary) softwareReads.push(binary)
    return actualFs.open(...args)
  })
  const link = new MemoryServer(randomUUID()).link()
  const claim = vi.spyOn(link, 'claimRun').mockRejectedValue(Error('Fixture claim refused'))
  const register = vi.spyOn(link, 'registerDevice')
  const daemon = new Daemon({ dataDir: tempDir(), flavor: 'dev', link, credential: 'fixture-device',
    initialRunId: randomUUID(), hostedSubscriptions: true, e2bContainerRuntime: cloud,
    harnessBinaries: { claude_code: binary }, modelProbe: false, quotaSource: null,
    heartbeatMs: 60_000, log: createLogger({ level: 'silent' }),
  })
  cleanups.push(async () => { await daemon.stop() })
  return { daemon, claim, register, softwareReads }
}

it('registers and claims directly without prefetch, including repeated sync and credential rotation', async () => {
  const f = machine()
  await f.daemon.start()
  await f.daemon.syncWithServer()
  expect(f.register).toHaveBeenCalledTimes(1)
  expect(f.claim).toHaveBeenCalledTimes(1)
  await handlers['device.setCredential']({ credential: 'rotated-fixture-device' })
  await f.daemon.syncWithServer()
  await f.daemon.syncWithServer()
  expect(f.register).toHaveBeenCalledTimes(2)
  expect(f.claim).toHaveBeenCalledTimes(1)
  await f.daemon.stop()
  expect(prefetchHostedCliFiles).not.toHaveBeenCalled()
  expect(f.softwareReads).toEqual([])
  expect(nativeStart).not.toHaveBeenCalled()
})

it('does not add background software reads to a normal local or candidate daemon', async () => {
  const f = machine(false)
  await f.daemon.start()
  await f.daemon.syncWithServer()
  expect(f.register).toHaveBeenCalled()
  await f.daemon.stop()
  expect(prefetchHostedCliFiles).not.toHaveBeenCalled()
  expect(f.softwareReads).toEqual([])
  expect(nativeStart).not.toHaveBeenCalled()
})

it('preserves startup failure cleanup without starting background software reads or claiming', async () => {
  const f = machine(), failure = Error('Fixture UI startup failure')
  const entered = deferred(), fail = deferred()
  vi.mocked(RpcServer.prototype.listen).mockImplementation(async () => {
    entered.resolve()
    await fail.promise
    throw failure
  })
  const starting = f.daemon.start().catch(error => error)
  await entered.promise
  fail.resolve()
  expect(await starting).toBe(failure)
  await f.daemon.stop()
  expect(f.register).not.toHaveBeenCalled()
  expect(f.claim).not.toHaveBeenCalled()
  expect(prefetchHostedCliFiles).not.toHaveBeenCalled()
  expect(f.softwareReads).toEqual([])
  expect(nativeStart).not.toHaveBeenCalled()
})

it('still aborts and drains an in-flight claim before completing daemon stop', async () => {
  const f = machine(), entered = deferred(), aborted = deferred(), released = deferred()
  f.claim.mockImplementation(async (_deviceId, _runId, signal) => {
    if (!signal) throw Error('Claim cancellation signal is required')
    if (signal.aborted) aborted.resolve()
    else signal.addEventListener('abort', aborted.resolve, { once: true })
    entered.resolve()
    await released.promise
    throw Error('Fixture claim refused after drain')
  })
  cleanups.unshift(async () => { released.resolve() })
  await f.daemon.start()
  await f.daemon.syncWithServer()
  await entered.promise
  let stopped = false
  const stopping = f.daemon.stop().then(() => { stopped = true })
  await aborted.promise
  expect(stopped).toBe(false)
  released.resolve()
  await stopping
  expect(f.claim).toHaveBeenCalledTimes(1)
  expect(prefetchHostedCliFiles).not.toHaveBeenCalled()
  expect(f.softwareReads).toEqual([])
  expect(nativeStart).not.toHaveBeenCalled()
})
