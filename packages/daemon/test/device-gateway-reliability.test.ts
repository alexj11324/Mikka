import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Daemon } from '../src/main'
import { createLogger } from '../src/log'
import { MemoryServer, type ServerLink } from '../src/server-link'
import { runDeviceGateway, type DeviceGatewaySocket } from '../src/device-gateway'
import { SessionRejectedError } from '../src/server-link-http'
import * as service from '../src/service'
import { cleanupTempDirs, tempDir } from './helpers'

type Event = { data?: unknown; code?: number }
type EventType = 'open' | 'message' | 'close' | 'error'

class Socket implements DeviceGatewaySocket {
  static instances: Socket[] = []
  static connect: (socket: Socket) => void = socket => socket.emit('open')
  readyState = 0
  sent: string[] = []
  autoPong = true
  listeners = new Map<EventType, Set<(event: Event) => void>>()
  constructor(_url?: string, _protocols?: string[]) {
    Socket.instances.push(this)
    queueMicrotask(() => Socket.connect(this))
  }
  addEventListener(type: EventType, listener: (event: Event) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(listener)
  }
  removeEventListener(type: EventType, listener: (event: Event) => void) { this.listeners.get(type)?.delete(listener) }
  emit(type: EventType, event: Event = {}) {
    if (type === 'open') this.readyState = 1
    if (type === 'close') this.readyState = 3
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
  send(data: string) {
    this.sent.push(data)
    if (this.autoPong && data === 'ping') this.emit('message', { data: 'pong' })
  }
  close() { if (this.readyState !== 3) this.emit('close') }
}

const daemons: Daemon[] = []

function polling(fetchCommands = vi.fn<ServerLink['fetchCommands']>().mockResolvedValue([])) {
  const deviceGateway = vi.fn(async () => ({ url: 'wss://fixture.invalid', protocol: 'fixture-ticket' }))
  const ackCommands = vi.fn(async () => {})
  const send = vi.fn(async () => {})
  let active = false
  const daemon = new Daemon({
    dataDir: tempDir('mikka-gateway-'), flavor: 'dev', commandsWaitSeconds: 1,
    link: { ...new MemoryServer('device-1').link(), fetchCommands, deviceGateway, ackCommands },
    log: createLogger({ level: 'silent' }),
  })
  Reflect.set(daemon, 'device', { deviceId: 'device-1', credential: 'fixture' })
  Reflect.set(daemon, 'registered', true)
  Reflect.set(daemon, 'server', 'online')
  Reflect.set(daemon, 'journal', { get: () => ({ state: 'running' }) })
  Reflect.set(daemon, 'supervisor', {
    send, heartbeatRuns: () => active ? [{ runId: 'run-1' }] : [],
    check: vi.fn(), stop: async () => {},
  })
  Reflect.set(daemon, 'outbox', { pending: () => 0, close: async () => {} })
  const sync = vi.fn(async () => {})
  Reflect.set(daemon, 'syncWithServer', sync)
  Reflect.set(daemon, 'commandsLoop', Reflect.get(daemon, 'pollCommands').call(daemon))
  daemons.push(daemon)
  return { daemon, deviceGateway, fetchCommands, ackCommands, send, sync, setActive: (value: boolean) => { active = value } }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] })
  vi.spyOn(Math, 'random').mockReturnValue(0)
  Socket.instances = []
  Socket.connect = socket => socket.emit('open')
  vi.stubGlobal('WebSocket', Socket)
})

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.restoreAllMocks()
  cleanupTempDirs()
})

it('keeps the real command loop responsive without minting tickets during exponentially longer cooldowns', async () => {
  Socket.connect = socket => socket.emit('error')
  const { deviceGateway, fetchCommands } = polling()
  await vi.advanceTimersByTimeAsync(0)
  expect(deviceGateway).toHaveBeenCalledTimes(1)
  expect(fetchCommands).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(3_999)
  expect(deviceGateway).toHaveBeenCalledTimes(1)
  expect(fetchCommands).toHaveBeenCalledTimes(4)
  await vi.advanceTimersByTimeAsync(1)
  expect(deviceGateway).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(7_999)
  expect(deviceGateway).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(deviceGateway).toHaveBeenCalledTimes(3)
  expect(fetchCommands).toHaveBeenCalledTimes(13)
})

it('does not reset cooldown for sockets that open and promptly close', async () => {
  Socket.connect = socket => {
    socket.emit('open')
    setTimeout(() => socket.emit('close'), 1_000)
  }
  const { deviceGateway } = polling()
  await vi.advanceTimersByTimeAsync(6_000)
  expect(deviceGateway).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(7_999)
  expect(deviceGateway).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(deviceGateway).toHaveBeenCalledTimes(3)
})

it('holds one healthy idle connection for an hour with no further ticket, command or heartbeat HTTP calls', async () => {
  const { daemon, deviceGateway, fetchCommands, sync } = polling()
  await vi.advanceTimersByTimeAsync(0)
  expect(fetchCommands).toHaveBeenCalledOnce()
  expect(fetchCommands.mock.calls[0]?.[1]).toBe(0)
  expect(sync).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(3_600_000)
  expect(deviceGateway).toHaveBeenCalledOnce()
  expect(fetchCommands).toHaveBeenCalledOnce()
  expect(sync).toHaveBeenCalledOnce()
  expect(Socket.instances[0]?.sent).toHaveLength(120)
  await daemon.stop()
  expect(vi.getTimerCount()).toBe(0)
})

it('drains on every reconnect and acknowledges work while the socket is still held', async () => {
  const fetch = vi.fn<ServerLink['fetchCommands']>().mockResolvedValue([])
  const { deviceGateway, ackCommands, send } = polling(fetch)
  await vi.advanceTimersByTimeAsync(0)
  fetch.mockResolvedValueOnce([{ kind: 'input', runId: 'run-1', messageId: 'message-1', text: 'hello' }])
  Socket.instances[0]!.emit('message', { data: 'work' })
  await vi.advanceTimersByTimeAsync(0)
  expect(send).toHaveBeenCalledWith('run-1', 'hello')
  expect(ackCommands).toHaveBeenCalledWith('device-1', ['message-1'])
  expect(deviceGateway).toHaveBeenCalledOnce()
  Socket.instances[0]!.emit('close')
  await vi.advanceTimersByTimeAsync(4_000)
  expect(deviceGateway).toHaveBeenCalledTimes(2)
  expect(fetch.mock.calls.filter(([, wait]) => wait === 0)).toHaveLength(3)
})

it('restores recurring lease heartbeats when work arrives after idle suspended the timer', async () => {
  const { sync, setActive } = polling()
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(sync).toHaveBeenCalledOnce()
  setActive(true)
  Socket.instances[0]!.emit('message', { data: 'work' })
  await vi.advanceTimersByTimeAsync(0)
  expect(sync).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(105_000)
  expect(sync).toHaveBeenCalledTimes(9)
  setActive(false)
  await vi.advanceTimersByTimeAsync(15_000)
  expect(sync).toHaveBeenCalledTimes(10)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(sync).toHaveBeenCalledTimes(10)
})

it('waits a minute after another connection replaces this daemon', async () => {
  const { deviceGateway } = polling()
  await vi.advanceTimersByTimeAsync(0)
  Socket.instances[0]!.emit('close', { code: 4000 })
  await vi.advanceTimersByTimeAsync(59_999)
  expect(deviceGateway).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1)
  expect(deviceGateway).toHaveBeenCalledTimes(2)
})

it('times out an incomplete handshake and cleans up all listeners and timers', async () => {
  Socket.connect = () => {}
  const socket = new Socket()
  const onWork = vi.fn(async () => {})
  const done = runDeviceGateway(socket, { signal: new AbortController().signal, onWork })
  const failed = expect(done).rejects.toThrow('handshake timed out')
  await vi.advanceTimersByTimeAsync(10_000)
  await failed
  expect(onWork).not.toHaveBeenCalled()
  expect(socket.readyState).toBe(3)
  expect([...socket.listeners.values()].every(listeners => listeners.size === 0)).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it('leaves push mode when no pong has arrived for 90 seconds', async () => {
  const socket = new Socket()
  socket.autoPong = false
  const done = runDeviceGateway(socket, { signal: new AbortController().signal, onWork: async () => {} })
  const failed = expect(done).rejects.toThrow('pong timed out')
  await vi.advanceTimersByTimeAsync(90_000)
  await failed
  expect(socket.sent).toEqual(['ping', 'ping'])
  expect(vi.getTimerCount()).toBe(0)
})

it('coalesces a work burst into one additional serial read and rejects failed reads', async () => {
  const socket = new Socket()
  let release: () => void = () => {}
  const onWork = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    .mockRejectedValueOnce(new Error('read failed'))
  const done = runDeviceGateway(socket, { signal: new AbortController().signal, onWork })
  const failed = expect(done).rejects.toThrow('read failed')
  await vi.advanceTimersByTimeAsync(0)
  for (let i = 0; i < 100; i++) socket.emit('message', { data: 'work' })
  expect(onWork).toHaveBeenCalledOnce()
  release()
  await vi.advanceTimersByTimeAsync(0)
  await failed
  expect(onWork).toHaveBeenCalledTimes(2)
  expect(socket.readyState).toBe(3)
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps the uninstall grace credential through gateway command rejection, heartbeat receipt and deferred stop', async () => {
  const fetch = vi.fn<ServerLink['fetchCommands']>().mockRejectedValue(new SessionRejectedError())
  const { daemon } = polling(fetch)
  // Keep the real poll -> gateway -> syncPass -> deferred stop chain. Only
  // external process/platform boundaries and server replies are fixtures.
  Reflect.deleteProperty(daemon, 'syncWithServer')
  Reflect.set(daemon, 'runnerReport', async () => undefined)
  Reflect.set(daemon, 'worktrees', { diskUsage: async () => 0 })
  Reflect.set(daemon, 'rescanHarnesses', () => {})
  Object.assign(Reflect.get(daemon, 'supervisor'), { renewLeases: () => {}, activeRunIds: () => [] })
  const events: string[] = []
  const link = Reflect.get(daemon, 'options').link as ServerLink
  link.heartbeat = vi.fn(async (_id, status) => {
    events.push(status.completedDeviceCommands?.length ? 'receipt' : 'uninstall')
    return { leases: {}, deviceCommands: [{ id: 'uninstall-1', kind: 'uninstall' as const }] }
  })
  const rejected = vi.spyOn(daemon as unknown as { rejectDeviceSession(credential?: string): void }, 'rejectDeviceSession')
  let credentialAtUninstall: string | undefined
  vi.spyOn(service, 'uninstallService').mockImplementation(async clear => {
    credentialAtUninstall = Reflect.get(daemon, 'device').credential
    events.push('service')
    clear()
    events.push('cleared')
  })
  await vi.advanceTimersByTimeAsync(0)
  // This is a real event-loop turn: syncPass deliberately defers stop with
  // setImmediate because stop waits for its own heartbeat/commands loop.
  await new Promise<void>(resolve => setImmediate(resolve))
  await daemon.stop()
  await Promise.resolve()
  expect(events).toEqual(['uninstall', 'receipt', 'service', 'cleared'])
  expect(fetch).toHaveBeenCalledOnce()
  expect(rejected).not.toHaveBeenCalled()
  expect(credentialAtUninstall).toBe('fixture')
  expect(Reflect.get(daemon, 'device').credential).toBeUndefined()
})
