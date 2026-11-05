import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Daemon } from '../src/main'
import { createLogger } from '../src/log'
import { MemoryServer, type ServerLink } from '../src/server-link'
import { runDeviceGateway, type DeviceGatewaySocket } from '../src/device-gateway'
import { HttpServerLink, SessionRejectedError } from '../src/server-link-http'
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

function polling(fetchCommands = vi.fn<ServerLink['fetchCommands']>().mockResolvedValue([]), options: {
  deviceGateway?: NonNullable<ServerLink['deviceGateway']>
  commandsWaitSeconds?: number
  invalidateRunControls?: () => void
  setRunControlMode?: ServerLink['setRunControlMode']
  hostedSubscriptions?: boolean
} = {}) {
  const deviceGateway = vi.fn<NonNullable<ServerLink['deviceGateway']>>(options.deviceGateway ?? (async () => ({ url: 'wss://fixture.invalid', protocol: 'fixture-ticket' })))
  const ackCommands = vi.fn(async () => {})
  const send = vi.fn(async () => {})
  let active = false
  const daemon = new Daemon({
    dataDir: tempDir('mikka-gateway-'), flavor: 'dev', commandsWaitSeconds: options.commandsWaitSeconds ?? 1,
    link: { ...new MemoryServer('device-1').link(), fetchCommands, deviceGateway, ackCommands, invalidateRunControls: options.invalidateRunControls, setRunControlMode: options.setRunControlMode },
    log: createLogger({ level: 'silent' }), ...(options.hostedSubscriptions ? { hostedSubscriptions: true } : {}),
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

it('preserves heartbeat deadlines when an older HTTP server returns gateway 404 during long-poll fallback', async () => {
  const requests: string[] = []
  const http = new HttpServerLink('http://fixture.invalid', async input => {
    const path = new URL(String(input)).pathname
    requests.push(path)
    if (path.endsWith('/gateway')) return new Response('{}', { status: 404 })
    if (path.endsWith('/commands')) {
      // The SSH installation fixture returns after 500ms; the daemon must
      // still pace its requested 25s poll while heartbeating every 15s.
      await new Promise(resolve => setTimeout(resolve, 500))
      return new Response(JSON.stringify({ commands: [] }))
    }
    throw new Error(`Unexpected fixture request: ${path}`)
  })
  const { daemon, sync } = polling(vi.fn(http.fetchCommands.bind(http)), {
    deviceGateway: http.deviceGateway.bind(http), commandsWaitSeconds: 25,
  })
  const heartbeatTimes: number[] = []
  sync.mockImplementation(async () => { heartbeatTimes.push(performance.now()) })
  Reflect.get(daemon, 'schedule').call(daemon, 0)
  await vi.advanceTimersByTimeAsync(15_001)
  const before = sync.mock.calls.length
  await vi.advanceTimersByTimeAsync(40_000)
  expect(sync.mock.calls.length - before).toBeGreaterThanOrEqual(2)
  expect(heartbeatTimes).toEqual([0, 15_000, 30_000, 45_000])
  expect(requests.filter(path => path.endsWith('/gateway'))).toHaveLength(3)
  expect(requests.filter(path => path.endsWith('/commands'))).toHaveLength(3)
  expect(Socket.instances).toHaveLength(0)
})

it('restores an idle socket heartbeat once after disconnect without later failed handshakes postponing it', async () => {
  const { sync } = polling()
  await vi.advanceTimersByTimeAsync(0)
  expect(sync).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(sync).toHaveBeenCalledOnce()
  Socket.connect = socket => socket.emit('error')
  Socket.instances[0]!.emit('close')
  await vi.advanceTimersByTimeAsync(14_999)
  expect(sync).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1)
  expect(sync).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(sync).toHaveBeenCalledTimes(4)
})

it('preserves the pending active-run lease heartbeat when its open socket disconnects', async () => {
  const { sync, setActive } = polling()
  await vi.advanceTimersByTimeAsync(0)
  setActive(true)
  Socket.instances[0]!.emit('message', { data: 'work' })
  await vi.advanceTimersByTimeAsync(0)
  expect(sync).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(10_000)
  Socket.connect = socket => socket.emit('error')
  Socket.instances[0]!.emit('close')
  await vi.advanceTimersByTimeAsync(5_000)
  expect(sync).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(30_000)
  expect(sync).toHaveBeenCalledTimes(5)
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

it('invalidates run authority immediately even while the command drain is pending', async () => {
  const socket = new Socket()
  const abort = new AbortController()
  let release = () => {}
  const onWork = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    .mockResolvedValue(undefined)
  const onWorkAvailable = vi.fn()
  const done = runDeviceGateway(socket, { signal: abort.signal, onWork, onWorkAvailable })
  await vi.advanceTimersByTimeAsync(0)
  expect(onWorkAvailable).toHaveBeenCalledTimes(1)
  socket.emit('message', { data: 'work' })
  expect(onWorkAvailable).toHaveBeenCalledTimes(2)
  expect(onWork).toHaveBeenCalledTimes(1)
  socket.emit('message', { data: 'pong' })
  expect(onWorkAvailable).toHaveBeenCalledTimes(2)
  release()
  await vi.advanceTimersByTimeAsync(0)
  expect(onWork).toHaveBeenCalledTimes(2)
  abort.abort()
  await done
  socket.emit('message', { data: 'work' })
  expect(onWorkAvailable).toHaveBeenCalledTimes(2)
})

it('wires reconnect, work and disconnect to fresh checks without treating pong as authority', async () => {
  const invalidateRunControls = vi.fn()
  polling(undefined, { invalidateRunControls })
  await vi.advanceTimersByTimeAsync(0)
  expect(invalidateRunControls).toHaveBeenCalledTimes(1)
  Socket.instances[0]!.emit('message', { data: 'work' })
  await vi.advanceTimersByTimeAsync(0)
  expect(invalidateRunControls).toHaveBeenCalledTimes(2)
  Socket.instances[0]!.emit('message', { data: 'pong' })
  expect(invalidateRunControls).toHaveBeenCalledTimes(2)
  Socket.instances[0]!.emit('close')
  await vi.advanceTimersByTimeAsync(0)
  expect(invalidateRunControls).toHaveBeenCalledTimes(3)
})

it('drops the periodic run check only while a run-control push server holds the socket (#1212)', async () => {
  const setRunControlMode = vi.fn<NonNullable<ServerLink['setRunControlMode']>>()
  polling(undefined, { setRunControlMode, deviceGateway: async () => ({ url: 'wss://fixture.invalid', protocol: 'fixture-ticket', runControl: 'push' }) })
  await vi.advanceTimersByTimeAsync(0)
  expect(setRunControlMode.mock.calls.map(([mode]) => mode)).toEqual(['fallback', 'push'])
  Socket.instances[0]!.emit('close')
  await vi.advanceTimersByTimeAsync(0)
  expect(setRunControlMode).toHaveBeenLastCalledWith('fallback')
})

it('keeps the one-second run check against an older server that does not push run control', async () => {
  const setRunControlMode = vi.fn<NonNullable<ServerLink['setRunControlMode']>>()
  polling(undefined, { setRunControlMode })
  await vi.advanceTimersByTimeAsync(0)
  Socket.instances[0]!.emit('close')
  await vi.advanceTimersByTimeAsync(0)
  expect(new Set(setRunControlMode.mock.calls.map(([mode]) => mode))).toEqual(new Set(['legacy']))
})

it('a cloud computer that cannot get a gateway ticket checks its runs every 20 s, never every second', async () => {
  // A cloud device token could not mint a ticket (401), so cloud runs stayed on
  // the one-second check and re-read their subscription about every 3 s.
  const setRunControlMode = vi.fn<NonNullable<ServerLink['setRunControlMode']>>()
  const { deviceGateway } = polling(undefined, { setRunControlMode, hostedSubscriptions: true, deviceGateway: async () => { throw new SessionRejectedError() } })
  await vi.advanceTimersByTimeAsync(0)
  expect(deviceGateway).toHaveBeenCalled()
  expect(setRunControlMode).toHaveBeenCalled()
  expect(new Set(setRunControlMode.mock.calls.map(([mode]) => mode))).toEqual(new Set(['fallback']))
})

it('a cloud computer on the gateway drops the periodic run check like a local daemon', async () => {
  const setRunControlMode = vi.fn<NonNullable<ServerLink['setRunControlMode']>>()
  polling(undefined, { setRunControlMode, hostedSubscriptions: true, deviceGateway: async () => ({ url: 'wss://fixture.invalid', protocol: 'fixture-ticket', runControl: 'push' }) })
  await vi.advanceTimersByTimeAsync(0)
  expect(setRunControlMode.mock.calls.map(([mode]) => mode)).toEqual(['fallback', 'push'])
  Socket.instances[0]!.emit('close')
  await vi.advanceTimersByTimeAsync(0)
  expect(setRunControlMode).toHaveBeenLastCalledWith('fallback')
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
