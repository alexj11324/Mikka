import { afterEach, expect, it, vi } from 'vitest'
import { Daemon } from '../src/main'
import { createLogger } from '../src/log'
import { MemoryServer, type ServerLink } from '../src/server-link'
import { ServerUnreachableError } from '../src/errors'

const daemons: Daemon[] = []

function pollCommands(fetchCommands: ServerLink['fetchCommands'], commandsWaitSeconds?: number) {
  const ackCommands = vi.fn(async () => {})
  const send = vi.fn(async () => {})
  const daemon = new Daemon({ dataDir: '/unused-commands-poll-test', flavor: 'dev',
    link: { ...new MemoryServer('device-1').link(), fetchCommands, ackCommands },
    commandsWaitSeconds, log: createLogger({ level: 'silent' }) })
  // Isolate the polling boundary from RPC, filesystem and agent processes.
  Reflect.set(daemon, 'device', { deviceId: 'device-1', credential: 'fixture' })
  Reflect.set(daemon, 'registered', true)
  Reflect.set(daemon, 'journal', { get: () => ({ state: 'running' }) })
  Reflect.set(daemon, 'supervisor', { send, stop: async () => {} })
  Reflect.set(daemon, 'commandsLoop', Reflect.get(daemon, 'pollCommands').call(daemon))
  daemons.push(daemon)
  return { daemon, ackCommands, send }
}

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it.each([0, 5_000, 25_000])('paces an empty response after a %i ms server wait to one requested cycle', async serverWait => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const fetch = vi.fn<ServerLink['fetchCommands']>()
    .mockImplementationOnce(async () => {
      await new Promise(resolve => setTimeout(resolve, serverWait))
      return []
    })
    .mockResolvedValueOnce([]).mockRejectedValue(new Error('Unexpected additional poll'))
  const { daemon } = pollCommands(fetch)
  await vi.advanceTimersByTimeAsync(24_999)
  expect(fetch).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(fetch).toHaveBeenCalledTimes(2)
  await daemon.stop()
  expect(vi.getTimerCount()).toBe(0)
})

it('delivers and acknowledges a queued message immediately before the next poll', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const fetch = vi.fn<ServerLink['fetchCommands']>()
    .mockResolvedValueOnce([{ kind: 'input', runId: 'run-1', messageId: 'message-1', text: 'hello' }])
    .mockResolvedValueOnce([]).mockRejectedValue(new Error('Unexpected additional poll'))
  const { ackCommands, send } = pollCommands(fetch)
  await vi.advanceTimersByTimeAsync(0)
  expect(send).toHaveBeenCalledWith('run-1', 'hello')
  expect(ackCommands).toHaveBeenCalledWith('device-1', ['message-1'])
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('uses a one-second minimum when zero wait is configured', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const fetch = vi.fn<ServerLink['fetchCommands']>()
    .mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockRejectedValue(new Error('Unexpected additional poll'))
  pollCommands(fetch, 0)
  await vi.advanceTimersByTimeAsync(999)
  expect(fetch).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('stops an in-flight poll without scheduling an idle pause or another request', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const fetch = vi.fn<ServerLink['fetchCommands']>((_device, _wait, { signal } = {}) =>
    new Promise(resolve => signal?.addEventListener('abort', () => resolve([]), { once: true })))
  const { daemon } = pollCommands(fetch)
  await daemon.stop()
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('bounds consecutive failures to capped exponential backoff and cancels retries on stop', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const fetch = vi.fn<ServerLink['fetchCommands']>().mockRejectedValue(new ServerUnreachableError('offline'))
  const { daemon } = pollCommands(fetch)
  await vi.advanceTimersByTimeAsync(0)
  let calls = 1
  for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
    await vi.advanceTimersByTimeAsync(delay - 1)
    expect(fetch).toHaveBeenCalledTimes(calls)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetch).toHaveBeenCalledTimes(++calls)
  }
  await daemon.stop()
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(fetch).toHaveBeenCalledTimes(calls)
})

it('resets failure backoff after a successful response', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const error = new ServerUnreachableError('offline')
  const fetch = vi.fn<ServerLink['fetchCommands']>()
    .mockRejectedValueOnce(error).mockRejectedValueOnce(error)
    .mockResolvedValueOnce([]).mockRejectedValue(error)
  pollCommands(fetch)
  await vi.advanceTimersByTimeAsync(28_000)
  expect(fetch).toHaveBeenCalledTimes(4)
  await vi.advanceTimersByTimeAsync(999)
  expect(fetch).toHaveBeenCalledTimes(4)
  await vi.advanceTimersByTimeAsync(1)
  expect(fetch).toHaveBeenCalledTimes(5)
})

it('does not deliver work returned by a poll that resolves during shutdown', async () => {
  const fetch = vi.fn<ServerLink['fetchCommands']>((_device, _wait, { signal } = {}) =>
    new Promise(resolve => signal?.addEventListener('abort', () => resolve([
      { kind: 'input', runId: 'run-1', messageId: 'message-1', text: 'hello' },
    ]), { once: true })))
  const { daemon, send, ackCommands } = pollCommands(fetch)
  await daemon.stop()
  expect(send).not.toHaveBeenCalled()
  expect(ackCommands).not.toHaveBeenCalled()
})

it('resets backoff before immediately acknowledging work after failures', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const error = new ServerUnreachableError('offline')
  const fetch = vi.fn<ServerLink['fetchCommands']>()
    .mockRejectedValueOnce(error).mockRejectedValueOnce(error)
    .mockResolvedValueOnce([{ kind: 'input', runId: 'run-1', messageId: 'message-1', text: 'hello' }])
    .mockRejectedValue(error)
  const { ackCommands, send } = pollCommands(fetch)
  ackCommands.mockRejectedValue(error)
  await vi.advanceTimersByTimeAsync(3_000)
  expect(send).toHaveBeenCalledTimes(1)
  expect(ackCommands).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(999)
  expect(ackCommands).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(ackCommands).toHaveBeenCalledTimes(2)
})
