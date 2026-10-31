import { afterEach, expect, it, vi } from 'vitest'
import { Daemon } from '../src/main'
import { createLogger } from '../src/log'
import { MemoryServer, type ServerLink } from '../src/server-link'
import * as folders from '../src/fs-browse'

const daemons: Daemon[] = []

function pollFolders(fetchFsRequests: NonNullable<ServerLink['fetchFsRequests']>, commandsWaitSeconds?: number) {
  const answerFsRequest = vi.fn(async () => {})
  const daemon = new Daemon({ dataDir: '/unused-fs-poll-test', flavor: 'dev',
    link: { ...new MemoryServer('device-1').link(), fetchFsRequests, answerFsRequest },
    commandsWaitSeconds, log: createLogger({ level: 'silent' }) })
  // Exercise only polling, without starting the daemon's RPC server or other loops.
  Reflect.set(daemon, 'device', { deviceId: 'device-1', credential: 'fixture' })
  Reflect.set(daemon, 'registered', true)
  Reflect.set(daemon, 'fsLoop', Reflect.get(daemon, 'pollFolderRequests').call(daemon))
  daemons.push(daemon)
  return { daemon, answerFsRequest }
}

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('bounds immediately empty responses to the requested poll cycle and aborts the pause on stop', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const fetch = vi.fn<NonNullable<ServerLink['fetchFsRequests']>>()
    .mockResolvedValueOnce([]).mockResolvedValueOnce([])
    .mockRejectedValue(new Error('Unexpected additional poll'))
  const { daemon } = pollFolders(fetch)
  await vi.advanceTimersByTimeAsync(24_999)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(fetch).toHaveBeenCalledWith('device-1', 25, { signal: expect.any(AbortSignal) })
  await vi.advanceTimersByTimeAsync(1)
  expect(fetch).toHaveBeenCalledTimes(2)
  await daemon.stop()
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(25_000)
  expect(fetch).toHaveBeenCalledTimes(2)
})

it.each([5_000, 25_000])('only waits the remaining cycle after a %i ms server wait', async serverWait => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const fetch = vi.fn<NonNullable<ServerLink['fetchFsRequests']>>()
    .mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, serverWait))
      return []
    })
    .mockResolvedValueOnce([])
    .mockRejectedValue(new Error('Unexpected additional poll'))
  pollFolders(fetch)
  await vi.advanceTimersByTimeAsync(24_999)
  expect(fetch).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('answers queued requests immediately and fetches the next batch without an idle delay', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const result = { ok: false, code: 'not_found', message: 'Missing folder.' } as const
  vi.spyOn(folders, 'browseFolder').mockResolvedValue(result)
  const fetch = vi.fn<NonNullable<ServerLink['fetchFsRequests']>>()
    .mockResolvedValueOnce([{ id: 'request-1', path: '/repo' }])
    .mockResolvedValueOnce([])
    .mockRejectedValue(new Error('Unexpected additional poll'))
  const { answerFsRequest } = pollFolders(fetch)
  await vi.advanceTimersByTimeAsync(0)
  expect(answerFsRequest).toHaveBeenCalledWith('device-1', 'request-1', result)
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('still bounds empty polling when the configured server wait is zero', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const fetch = vi.fn<NonNullable<ServerLink['fetchFsRequests']>>()
    .mockResolvedValueOnce([]).mockResolvedValueOnce([])
    .mockRejectedValue(new Error('Unexpected additional poll'))
  pollFolders(fetch, 0)
  await vi.advanceTimersByTimeAsync(999)
  expect(fetch).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('does not start an idle pause when the server poll resolves during stop', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const fetch = vi.fn<NonNullable<ServerLink['fetchFsRequests']>>((_device, _wait, { signal } = {}) =>
    new Promise(resolve => signal?.addEventListener('abort', () => resolve([]), { once: true })))
  const { daemon } = pollFolders(fetch)
  await daemon.stop()
  expect(vi.getTimerCount()).toBe(0)
  expect(fetch).toHaveBeenCalledTimes(1)
})
