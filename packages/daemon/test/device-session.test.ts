// The device session (decision 2026-11-17-2215): one socket, pinged every
// 10 s, redialed with backoff; no heartbeat, no long-poll, no fallback.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as protocol from '@mikka/protocol'
import { Daemon } from '../src/main'
import { createLogger } from '../src/log'
import { MemoryServer, type ServerLink } from '../src/server-link'
import * as deviceGateway from '../src/device-gateway'
import { deviceGatewayRetryDelay, runDeviceGateway, type DeviceGatewaySocket } from '../src/device-gateway'
import { HttpServerLink, SessionRejectedError } from '../src/server-link-http'
import { DaemonUpgradeRequiredError, DeviceGatewayRequiredError, DeviceSessionRequiredError } from '../src/errors'
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
  constructor() {
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
    for (const listener of [...this.listeners.get(type) ?? []]) listener(event)
  }
  send(data: string) {
    this.sent.push(data)
    if (this.autoPong && data === 'ping') this.emit('message', { data: 'pong' })
  }
  close() { if (this.readyState !== 3) this.emit('close') }
}
const last = () => Socket.instances.at(-1)!

const daemons: Daemon[] = []
/** Every call the daemon makes on its server link, in order, with the fake clock's time. */
type Call = { name: string; at: number; args: unknown[] }

/**
 * A daemon whose session runs for real against a counting link. Only the
 * filesystem, agents and process boundaries are fixtures.
 */
function sessionDaemon(overrides: Partial<ServerLink> = {}, options: { cloudComputer?: true; autoUpdate?: { install(version: string): Promise<void>; latest?(): Promise<string | undefined> }; runs?: string[] } = {}) {
  const calls: Call[] = []
  const base: ServerLink = {
    ...new MemoryServer('device-1').link(),
    deviceGateway: async () => ({ url: 'wss://fixture.invalid', protocol: `mikka-ticket-1-${'0'.repeat(64)}` }),
    fetchCommands: async () => [],
    ackCommands: async () => {},
    report: async () => ({}),
    listRepos: async () => [],
    pendingRuns: async () => [],
    ...overrides,
  }
  const link = new Proxy(base, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (typeof value !== 'function' || key === 'openDeviceGateway' || key === 'invalidateRunControls' || key === 'onUpgradeRequired') return value
      return (...args: unknown[]) => { calls.push({ name: String(key), at: Date.now(), args }); return value.apply(target, args) }
    },
  }) as ServerLink
  link.openDeviceGateway = () => new Socket()
  const runs = options.runs ?? []
  const supervisor = {
    check: vi.fn(), sessionOpened: vi.fn(), sessionClosed: vi.fn(),
    activeRunIds: () => runs, list: () => [], resumeAll: async () => {}, stop: async () => {}, saveCheckpoints: async () => {},
  }
  const daemon = new Daemon({ dataDir: tempDir('mikka-session-'), flavor: 'dev', link, log: createLogger({ level: 'silent' }),
    random: () => 1, ...(options.cloudComputer ? { cloudComputer: true } : {}), ...(options.autoUpdate ? { autoUpdate: options.autoUpdate } : {}) })
  Reflect.set(daemon, 'device', { deviceId: 'device-1', credential: 'fixture' })
  Reflect.set(daemon, 'registered', true)
  Reflect.set(daemon, 'journal', { get: () => undefined, all: () => [] })
  Reflect.set(daemon, 'supervisor', supervisor)
  Reflect.set(daemon, 'outbox', { pending: () => 0, flushAll: async () => {}, close: async () => {} })
  Reflect.set(daemon, 'worktrees', { diskUsage: async () => 0, cachedDiskUsage: () => 0 })
  Reflect.set(daemon, 'runnerReport', async () => undefined)
  Reflect.set(daemon, 'saveDevice', function (this: Daemon, patch: object) { Reflect.set(this, 'device', { ...Reflect.get(this, 'device'), ...patch }) })
  Reflect.set(daemon, 'pruneWorktrees', async () => {})
  Reflect.set(daemon, 'swept', true)
  Reflect.set(daemon, 'deviceType', 'laptop')
  // Registration is a fixture: it records the credential the link would use.
  Reflect.set(daemon, 'register', vi.fn(async function (this: Daemon, credential: string) {
    calls.push({ name: 'registerDevice', at: Date.now(), args: [credential] })
    Reflect.set(this, 'registered', true)
  }))
  link.onUpgradeRequired?.(latest => Reflect.get(daemon, 'enterUpdateRequired').call(daemon, latest))
  daemons.push(daemon)
  const start = () => Reflect.get(daemon, 'startSession').call(daemon)
  const named = (name: string) => calls.filter(call => call.name === name)
  return { daemon, calls, named, supervisor, start, link }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date', 'setImmediate'] })
  Socket.instances = []
  Socket.connect = socket => socket.emit('open')
})

afterEach(async () => {
  vi.useRealTimers()
  for (const daemon of daemons.splice(0)) await daemon.stop()
  vi.restoreAllMocks()
  cleanupTempDirs()
})

it('mirrors the protocol\'s session numbers', () => {
  expect(deviceGateway.DEVICE_GATEWAY_PING_MS).toBe(protocol.DEVICE_GATEWAY_PING_MS)
  expect(deviceGateway.DEVICE_GATEWAY_SILENCE_MS).toBe(protocol.DEVICE_GATEWAY_SILENCE_MS)
  expect(deviceGateway.DEVICE_GATEWAY_RETRY_MIN_MS).toBe(protocol.DEVICE_GATEWAY_RETRY_MIN_MS)
  expect(deviceGateway.DEVICE_GATEWAY_RETRY_MAX_MS).toBe(protocol.DEVICE_GATEWAY_RETRY_MAX_MS)
  expect(deviceGateway.DEVICE_GATEWAY_UPDATE_REQUIRED_CODE).toBe(protocol.DEVICE_GATEWAY_UPDATE_REQUIRED_CODE)
})

it('redial delays double from 0.5 s to 30 s, half of each jittered', () => {
  expect([1, 2, 3, 4, 5, 6, 7, 8, 20].map(n => deviceGatewayRetryDelay(n, () => 1))).toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000])
  expect(deviceGatewayRetryDelay(1, () => 0)).toBe(500)
  expect(deviceGatewayRetryDelay(7, () => 0)).toBe(15_000)
})

it('sends the session header on every request, including the ones the daemon sends directly', async () => {
  vi.useRealTimers()
  const seen: { path: string; header: string | null }[] = []
  const link = new HttpServerLink('https://mikka.example.test/mikka', (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input))
    seen.push({ path: url.pathname, header: new Headers(init?.headers).get(protocol.DEVICE_SESSION_HEADER) })
    const body = url.pathname.endsWith('/register') ? { deviceId: 'device-1', workspaceId: '10000000-0000-4000-8000-000000000002' }
      : url.pathname.endsWith('/report') ? {}
      : url.pathname.endsWith('/gateway') ? { url: 'wss://gateway.example.test/device', protocol: `mikka-ticket-1-${'a'.repeat(64)}` }
      : url.pathname.endsWith('/commands') ? { commands: [] }
      : url.pathname.endsWith('/repos') ? { repos: [] }
      : url.pathname.endsWith('/runs') ? { runIds: [] } : null
    return new Response(body ? JSON.stringify(body) : null, { status: body ? 200 : 204, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch)
  await link.registerDevice('fixture', { name: 'host', hostname: 'host', platform: 'linux', arch: 'x64', daemonVersion: '0.0.1', protocolVersion: 1, harnesses: [] })
  await link.report('device-1', {})
  await link.deviceGateway('device-1')
  await link.fetchCommands('device-1', 0)
  await link.ackCommands('device-1', ['message-1'])
  await link.listRepos('device-1')
  await link.pendingRuns('device-1')
  await link.updateRun('run-1', { state: 'running' })
  expect(seen.length).toBe(8)
  expect(seen.every(request => request.header === String(protocol.DEVICE_SESSION_VERSION))).toBe(true)
})

it('426 from any route raises DaemonUpgradeRequiredError and tells the daemon, with the release the server names', async () => {
  vi.useRealTimers()
  const heard: (string | undefined)[] = []
  const link = new HttpServerLink('https://mikka.example.test', (async () => new Response(JSON.stringify({ error: 'daemonUpgradeRequired', daemonVersions: { min: '0.0.900', latest: '0.0.901' } }), { status: 426 })) as typeof fetch)
  link.onUpgradeRequired(latest => heard.push(latest))
  await expect(link.listRepos('device-1')).rejects.toBeInstanceOf(DaemonUpgradeRequiredError)
  await expect(link.claimRun('device-1', 'run-1')).rejects.toMatchObject({ latest: '0.0.901' })
  expect(heard).toEqual(['0.0.901', '0.0.901'])
})

it('maps 503 deviceGatewayRequired on the ticket and 409 deviceSessionRequired on a claim', async () => {
  vi.useRealTimers()
  const link = new HttpServerLink('https://mikka.example.test', (async (input: URL | string) => String(input).endsWith('/gateway')
    ? new Response(JSON.stringify({ error: 'deviceGatewayRequired' }), { status: 503 })
    : new Response(JSON.stringify({ error: 'deviceSessionRequired' }), { status: 409 })) as typeof fetch)
  await expect(link.deviceGateway('device-1')).rejects.toBeInstanceOf(DeviceGatewayRequiredError)
  await expect(link.claimRun('device-1', 'run-1')).rejects.toBeInstanceOf(DeviceSessionRequiredError)
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

it('pings every 10 s and drops a socket that said nothing for 30 s', async () => {
  const socket = new Socket()
  socket.autoPong = false
  const done = runDeviceGateway(socket, { signal: new AbortController().signal, onWork: async () => {} })
  const failed = expect(done).rejects.toThrow('went quiet')
  await vi.advanceTimersByTimeAsync(29_999)
  expect(socket.sent).toEqual(['ping', 'ping'])
  await vi.advanceTimersByTimeAsync(1)
  await failed
  expect(vi.getTimerCount()).toBe(0)
})

it('coalesces a work burst into one additional serial read and closes the socket on a failed read', async () => {
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

it('invalidates run authority at once on a push even while the read is pending; a pong is not a push', async () => {
  const socket = new Socket()
  const abort = new AbortController()
  let release = () => {}
  const onWork = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve })).mockResolvedValue(undefined)
  const onWorkAvailable = vi.fn()
  const done = runDeviceGateway(socket, { signal: abort.signal, onWork, onWorkAvailable })
  await vi.advanceTimersByTimeAsync(0)
  expect(onWorkAvailable).toHaveBeenCalledTimes(1)
  socket.emit('message', { data: 'work' })
  expect(onWorkAvailable).toHaveBeenCalledTimes(2)
  socket.emit('message', { data: 'pong' })
  expect(onWorkAvailable).toHaveBeenCalledTimes(2)
  release()
  await vi.advanceTimersByTimeAsync(0)
  expect(onWork).toHaveBeenCalledTimes(2)
  abort.abort()
  await done
})

it('an open, idle session makes no request for an hour: one ticket, one read, one report, then only pings', async () => {
  const { start, calls, supervisor } = sessionDaemon()
  start()
  await vi.advanceTimersByTimeAsync(0)
  expect(calls.map(call => call.name)).toEqual(['deviceGateway', 'report', 'fetchCommands', 'listRepos', 'pendingRuns'])
  expect(supervisor.sessionOpened).toHaveBeenCalledOnce()
  const before = calls.length
  await vi.advanceTimersByTimeAsync(60 * 60_000)
  expect(calls.length).toBe(before)
  expect(last().sent.length).toBe(360)
  // The local timer ran the lease and watchdog check meanwhile, without a request.
  expect(supervisor.check.mock.calls.length).toBeGreaterThanOrEqual(700)
})

it('a push reads again; the report goes out once per open and then only when something changed', async () => {
  const { start, daemon, named } = sessionDaemon()
  start()
  await vi.advanceTimersByTimeAsync(0)
  last().emit('message', { data: 'work' })
  await vi.advanceTimersByTimeAsync(0)
  expect(named('fetchCommands').length).toBe(2)
  expect(named('report').length).toBe(1)
  Reflect.set(daemon, 'harnesses', [{ harness: 'codex', installed: true, version: '1.0.0' }])
  last().emit('message', { data: 'work' })
  await vi.advanceTimersByTimeAsync(0)
  expect(named('report').length).toBe(2)
  expect(named('report')[1]!.args[1]).toMatchObject({ harnesses: [{ harness: 'codex' }] })
  last().emit('close')
  await vi.advanceTimersByTimeAsync(500)
  expect(named('report').length).toBe(3) // once after the new socket opened
})

it('a dropped socket is only redialed, from 0.5 s doubling to 30 s; nothing else is sent while it is down', async () => {
  const { start, calls, named, supervisor } = sessionDaemon()
  start()
  await vi.advanceTimersByTimeAsync(0)
  const opened = calls.length
  Socket.connect = socket => socket.emit('close')
  last().emit('close')
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  expect(calls.slice(opened).every(call => call.name === 'deviceGateway')).toBe(true)
  const tickets = named('deviceGateway').map(call => call.at)
  const gaps = tickets.slice(1).map((at, i) => at - tickets[i]!)
  expect(gaps.slice(0, 9)).toEqual([500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000])
  expect(supervisor.sessionClosed).toHaveBeenCalled()
})

it('a replaced socket (4000) redials normally, and a socket that held a minute resets the backoff', async () => {
  const { start, named } = sessionDaemon()
  start()
  await vi.advanceTimersByTimeAsync(0)
  last().emit('close', { code: 4000 })
  await vi.advanceTimersByTimeAsync(500)
  expect(named('deviceGateway').length).toBe(2)
  last().emit('close')
  await vi.advanceTimersByTimeAsync(999)
  expect(named('deviceGateway').length).toBe(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(named('deviceGateway').length).toBe(3)
  await vi.advanceTimersByTimeAsync(60_000)
  last().emit('close')
  await vi.advanceTimersByTimeAsync(500)
  expect(named('deviceGateway').length).toBe(4)
})

it.each([
  ['a 426 on the ticket', { deviceGateway: async () => { throw new DaemonUpgradeRequiredError() } }, undefined],
  ['a 426 on the report', { report: async () => { throw new DaemonUpgradeRequiredError() } }, undefined],
  ['a 426 on a claim', { pendingRuns: async () => ['run-1'], claimRun: async () => { throw new DaemonUpgradeRequiredError() } }, undefined],
  ['a gateway close 4001', {}, 4001],
] as const)('%s ends the session for good: no further request, and status says update_required', async (_case, overrides, closeCode) => {
  const { start, daemon, calls } = sessionDaemon(overrides as Partial<ServerLink>)
  start()
  await vi.advanceTimersByTimeAsync(0)
  if (closeCode) last().emit('close', { code: closeCode })
  await vi.advanceTimersByTimeAsync(0)
  const stoppedAt = calls.length
  await vi.advanceTimersByTimeAsync(60 * 60_000)
  expect(calls.length).toBe(stoppedAt)
  expect(daemon.status().session).toBe('update_required')
  expect(daemon.status().server).toBe('offline')
  await expect(Reflect.get(daemon, 'claimAndStart').call(daemon, 'run-2')).rejects.toBeInstanceOf(DaemonUpgradeRequiredError)
})

it('a managed install that must update installs the release the refusal names, or npm\'s latest, once no run is left', async () => {
  const restart = vi.spyOn(service, 'restartService').mockResolvedValue(undefined)
  const runs = ['run-1']
  const install = vi.fn(async (_version: string) => {})
  const latest = vi.fn(async () => '999.0.0')
  const { start, daemon } = sessionDaemon({}, { autoUpdate: { install, latest }, runs })
  start()
  await vi.advanceTimersByTimeAsync(0)
  last().emit('close', { code: 4001 })
  await vi.advanceTimersByTimeAsync(0)
  expect(latest).toHaveBeenCalledOnce()
  expect(install).not.toHaveBeenCalled()
  runs.length = 0
  await vi.advanceTimersByTimeAsync(5_000) // the local timer
  await Reflect.get(daemon, 'maintenance')
  expect(install).toHaveBeenCalledExactlyOnceWith('999.0.0')
  expect(restart).toHaveBeenCalledOnce()

  const named = sessionDaemon({ deviceGateway: async () => { throw new DaemonUpgradeRequiredError('998.0.0') } }, { autoUpdate: { install, latest } })
  named.start()
  await vi.advanceTimersByTimeAsync(0)
  await Reflect.get(named.daemon, 'maintenance')
  expect(latest).toHaveBeenCalledOnce() // not asked again: the refusal named the release
  expect(install).toHaveBeenLastCalledWith('998.0.0')
})

it('a server without a gateway gets one ticket request every 30 s and nothing else, until it has one', async () => {
  let gateway = false
  const { start, daemon, calls } = sessionDaemon({ deviceGateway: async () => {
    if (!gateway) throw new DeviceGatewayRequiredError()
    return { url: 'wss://fixture.invalid', protocol: `mikka-ticket-1-${'0'.repeat(64)}` }
  } })
  start()
  await vi.advanceTimersByTimeAsync(0)
  expect(daemon.status().session).toBe('gateway_required')
  await vi.advanceTimersByTimeAsync(90_000)
  expect(calls.map(call => call.name)).toEqual(['deviceGateway', 'deviceGateway', 'deviceGateway', 'deviceGateway'])
  await expect(Reflect.get(daemon, 'claimAndStart').call(daemon, 'run-1')).rejects.toBeInstanceOf(DeviceGatewayRequiredError)
  gateway = true
  await vi.advanceTimersByTimeAsync(30_000)
  expect(daemon.status().session).toBe('open')
  expect(calls.map(call => call.name)).toContain('fetchCommands')
})

it('a claim refused for want of an open session redials the socket; the claim is tried again once per new socket', async () => {
  const claimRun = vi.fn(async () => { throw new DeviceSessionRequiredError() })
  const { start, named } = sessionDaemon({ pendingRuns: async () => ['run-1'], claimRun })
  start()
  await vi.advanceTimersByTimeAsync(0)
  expect(claimRun).toHaveBeenCalledOnce()
  expect(named('deviceGateway').length).toBe(1)
  await vi.advanceTimersByTimeAsync(499)
  expect(claimRun).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1)
  expect(named('deviceGateway').length).toBe(2)
  expect(claimRun).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(claimRun).toHaveBeenCalledTimes(3)
})

it('a cloud worker rotates its token once, an hour before it expires, and re-arms from the new expiry', async () => {
  const expiry = (fromNow: number) => new Date(Date.now() + fromNow).toISOString()
  const next = `orv_${'b'.repeat(43)}`
  const report = vi.fn<ServerLink['report']>(async (_id, sent) => sent.rotateCloudCredential ? { cloudCredential: next, cloudCredentialExpiresAt: expiry(3 * 60 * 60_000) } : {})
  const { start, daemon, named } = sessionDaemon({
    report,
    deviceGateway: async () => ({ url: 'wss://fixture.invalid', protocol: `mikka-ticket-1-${'0'.repeat(64)}`, cloudCredentialExpiresAt: expiry(2 * 60 * 60_000) }),
  }, { cloudComputer: true })
  start()
  await vi.advanceTimersByTimeAsync(0)
  const rotations = () => report.mock.calls.filter(([, sent]) => sent.rotateCloudCredential)
  await vi.advanceTimersByTimeAsync(60 * 60_000 - 1)
  expect(rotations()).toHaveLength(0)
  await vi.advanceTimersByTimeAsync(1)
  expect(rotations()).toHaveLength(1)
  expect(Reflect.get(daemon, 'device').credential).toBe(next)
  expect(named('registerDevice').at(-1)!.args[0]).toBe(next)
  await vi.advanceTimersByTimeAsync(2 * 60 * 60_000 - 1)
  expect(rotations()).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(rotations()).toHaveLength(2)
})

it('a refused session waits for a new credential without dialing; signing in dials at once', async () => {
  const { start, daemon, named } = sessionDaemon({ deviceGateway: async () => { throw new SessionRejectedError() } })
  start()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(named('deviceGateway').length).toBe(1)
  expect(daemon.status().session).toBe('signed_out')
  Reflect.set(daemon, 'options', { ...Reflect.get(daemon, 'options'), link: { ...Reflect.get(daemon, 'options').link, deviceGateway: async () => ({ url: 'wss://fixture.invalid', protocol: `mikka-ticket-1-${'0'.repeat(64)}` }) } })
  const handlers = Reflect.get(daemon, 'handlers').call(daemon)
  handlers['device.setCredential']({ credential: 'fresh' })
  await vi.advanceTimersByTimeAsync(0)
  expect(daemon.status().session).toBe('open')
})

it('a failed automatic update is reported once, when it fails, without waiting for a push', async () => {
  const reports: protocol.DeviceReport[] = []
  let named = false
  const install = vi.fn(async () => { throw new Error('npm install failed') })
  const { start } = sessionDaemon({
    // The first report's answer names a newer release; the daemon installs it when idle.
    report: async (_id, sent) => { reports.push(sent); if (named) return {}; named = true; return { daemonVersions: { min: '0.0.1', latest: '9.9.9' } } },
  }, { autoUpdate: { install } })
  start()
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(install).toHaveBeenCalledWith('9.9.9')
  const failed = reports.filter(report => report.updateFailure)
  expect(failed).toHaveLength(1)
  expect(failed[0].updateFailure).toMatchObject({ version: '9.9.9', code: 'install_failed' })
  const sent = reports.length
  await vi.advanceTimersByTimeAsync(60_000)
  expect(reports).toHaveLength(sent)
})

it('a device removed while connected asks its report once when the commands read refuses it, and uninstalls', async () => {
  const uninstall = vi.spyOn(service, 'uninstallService').mockImplementation(async clear => { clear() })
  const command = { id: '10000000-0000-4000-8000-0000000000ab', kind: 'uninstall' as const }
  let removed = false
  const reports: protocol.DeviceReport[] = []
  const { start, daemon } = sessionDaemon({
    // Nothing changed on the device, so the push itself sends no report.
    report: async (_id, sent) => { reports.push(sent); return removed ? { deviceCommands: [command] } : {} },
    fetchCommands: async () => { if (removed) throw new SessionRejectedError(); return [] },
  })
  start()
  await vi.advanceTimersByTimeAsync(0)
  expect(reports).toHaveLength(1)
  removed = true
  last().emit('message', { data: 'work' })
  await vi.advanceTimersByTimeAsync(0)
  vi.useRealTimers()
  await new Promise<void>(resolve => setImmediate(resolve))
  await daemon.stop()
  expect(uninstall).toHaveBeenCalledOnce()
  expect(reports.at(-1)?.completedDeviceCommands).toEqual([command.id])
  expect(Reflect.get(daemon, 'device').credential).toBeUndefined()
})

it('a refused commands read with no uninstall waiting signs the device out', async () => {
  let refused = false
  const { start, daemon } = sessionDaemon({ fetchCommands: async () => { if (refused) throw new SessionRejectedError(); return [] } })
  start()
  await vi.advanceTimersByTimeAsync(0)
  refused = true
  last().emit('message', { data: 'work' })
  await vi.advanceTimersByTimeAsync(0)
  expect(Reflect.get(daemon, 'device').credential).toBeUndefined()
  expect(daemon.status().session).toBe('signed_out')
})

it('an uninstall from the report runs before a commands read can refuse the removed device', async () => {
  const uninstall = vi.spyOn(service, 'uninstallService').mockImplementation(async clear => { clear() })
  const reports: protocol.DeviceReport[] = []
  const { start, daemon } = sessionDaemon({
    report: async (_id, sent) => { reports.push(sent); return { deviceCommands: [{ id: '10000000-0000-4000-8000-0000000000aa', kind: 'uninstall' }] } },
    fetchCommands: async () => { throw new SessionRejectedError() },
  })
  start()
  await vi.advanceTimersByTimeAsync(0)
  vi.useRealTimers()
  await new Promise<void>(resolve => setImmediate(resolve))
  await daemon.stop()
  expect(uninstall).toHaveBeenCalledOnce()
  expect(reports.at(-1)?.completedDeviceCommands).toEqual(['10000000-0000-4000-8000-0000000000aa'])
  expect(Reflect.get(daemon, 'device').credential).toBeUndefined()
})
