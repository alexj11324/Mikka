import { randomUUID } from 'node:crypto'
import { fstatSync, realpathSync, writeFileSync } from 'node:fs'
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

// These are daemon I/O scheduling tests, not execution/host admission tests.
// The real resolver and file reads run; no native adapter is ever started.
vi.mock('../src/subscription-hosted-runner', async original => {
  const actual = await original<typeof import('../src/subscription-hosted-runner')>()
  const refused = async () => { throw Error('No native task is authorized in this scheduling test') }
  return { ...actual, createHostedBotRunner: async (host: Parameters<typeof actual.createHostedBotRunner>[0]) => ({
    binaries: hostedBinaries(host.binaries), harnesses: ['claude_code'], start: refused, prepare: refused, command: refused,
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
function machine(cloud = true, blockRead = true) {
  const binary = join(realpathSync(tempDir()), 'claude')
  writeFileSync(binary, Buffer.alloc(400_007, 61), { mode: 0o755 })
  const entered = deferred(), release = deferred(), descriptors: number[] = []
  vi.mocked(fs.open).mockImplementation(async (...args) => {
    const file = await actualFs.open(...args)
    if (String(args[0]) === binary) {
      descriptors.push(file.fd)
      const read = file.read.bind(file)
      vi.spyOn(file, 'read').mockImplementation(async (...values) => {
        const value = await Reflect.apply(read, file, values)
        entered.resolve()
        if (blockRead) await release.promise
        return value
      })
    }
    return file
  })
  const link = new MemoryServer(randomUUID()).link()
  const claim = vi.spyOn(link, 'claimRun').mockRejectedValue(Error('Fixture claim refused'))
  const register = vi.spyOn(link, 'registerDevice')
  const daemon = new Daemon({ dataDir: tempDir(), flavor: 'dev', link, credential: 'fixture-device',
    initialRunId: randomUUID(), hostedSubscriptions: true, e2bContainerRuntime: cloud,
    harnessBinaries: { claude_code: binary }, modelProbe: false, quotaSource: null,
    heartbeatMs: 60_000, log: createLogger({ level: 'silent' }),
  })
  cleanups.push(async () => { release.resolve(); await daemon.stop() })
  return { daemon, claim, register, entered, release, descriptors }
}

it('does not wait for prefetch to register or claim, and credential rotation does not start another pass', async () => {
  const f = machine()
  await f.daemon.start()
  expect(prefetchHostedCliFiles).toHaveBeenCalledTimes(1)
  await f.entered.promise
  await f.daemon.syncWithServer()
  expect(f.register).toHaveBeenCalled()
  expect(f.claim).toHaveBeenCalledTimes(1)
  const prefetch = vi.mocked(prefetchHostedCliFiles).mock.results[0]!.value
  let completed = false
  void prefetch.done.then(() => { completed = true })
  await handlers['device.setCredential']({ credential: 'rotated-fixture-device' })
  await f.daemon.syncWithServer()
  expect(completed).toBe(false)
  expect(prefetchHostedCliFiles).toHaveBeenCalledTimes(1)
  const stopped = f.daemon.stop()
  let stopCompleted = false
  void stopped.then(() => { stopCompleted = true })
  await Promise.resolve()
  expect(stopCompleted).toBe(false)
  f.release.resolve()
  await stopped
  expect(await prefetch.done).toMatchObject({ status: 'aborted', files: 0 })
  for (const fd of f.descriptors) expect(() => fstatSync(fd)).toThrow()
})

it('does not add prefetch to a normal local or candidate daemon', async () => {
  const f = machine(false, false)
  await f.daemon.start()
  await f.daemon.syncWithServer()
  expect(f.register).toHaveBeenCalled()
  expect(prefetchHostedCliFiles).not.toHaveBeenCalled()
  expect(f.descriptors).toEqual([])
})

it('drains pending file I/O when daemon startup itself fails', async () => {
  const f = machine(), failure = Error('Fixture UI startup failure'), fail = deferred(), aborted = deferred()
  vi.mocked(RpcServer.prototype.listen).mockImplementation(async () => {
    await f.entered.promise
    await fail.promise
    throw failure
  })
  const starting = f.daemon.start().catch(error => error)
  await f.entered.promise
  const prefetch = vi.mocked(prefetchHostedCliFiles).mock.results[0]!.value
  const abort = prefetch.abort.bind(prefetch)
  vi.spyOn(prefetch, 'abort').mockImplementation(() => { abort(); aborted.resolve() })
  fail.resolve()
  await aborted.promise
  f.release.resolve()
  expect(await starting).toBe(failure)
  expect(await prefetch.done).toMatchObject({ status: 'aborted' })
  expect(f.register).not.toHaveBeenCalled()
  for (const fd of f.descriptors) expect(() => fstatSync(fd)).toThrow()
})
