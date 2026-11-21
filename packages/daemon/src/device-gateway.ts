// The device session (decision 2026-11-17-2215): one WebSocket to the device
// gateway is the daemon's only link to the server's push. While it is open the
// server counts the device online and keeps its runs' leases; the daemon pings
// it every 10 s and redials when it goes quiet. When it is down the daemon only
// redials, with jittered backoff from 0.5 s to 30 s. There is no heartbeat and
// no long-poll fallback.
//
// The numbers mirror `@mikka/protocol/device` ("Device session"); a test keeps
// them equal. This file imports nothing, so node's strip-types tests and the
// acceptance scripts load it directly.

/** Text the gateway answers without waking. See cloudflare/device-gateway/src/session.ts. */
export const DEVICE_GATEWAY_PING = "ping"
export const DEVICE_GATEWAY_PING_MS = 10_000
/** No message at all (pong or work) for this long: the socket is dead. */
export const DEVICE_GATEWAY_SILENCE_MS = 30_000
export const DEVICE_GATEWAY_HANDSHAKE_MS = 10_000
export const DEVICE_GATEWAY_RETRY_MIN_MS = 500
export const DEVICE_GATEWAY_RETRY_MAX_MS = 30_000
/** A socket that stayed open this long resets the backoff to its minimum. */
export const DEVICE_GATEWAY_STABLE_MS = 60_000
/** Close code: another socket of this device replaced this one. A normal redial. */
export const DEVICE_GATEWAY_REPLACED_CODE = 4000
/** Close code: this daemon must update before it can be used. */
export const DEVICE_GATEWAY_UPDATE_REQUIRED_CODE = 4001

type SocketEvent = { data?: unknown; code?: number }
type SocketEventType = "open" | "message" | "close" | "error"

export class DeviceGatewayClosedError extends Error {
  readonly code?: number
  constructor(code?: number) { super("device gateway closed"); this.code = code }
}

export interface DeviceGatewaySocket {
  readyState: number
  send(data: string): void
  close(): void
  addEventListener(type: SocketEventType, listener: (event: SocketEvent) => void): void
  removeEventListener?(type: SocketEventType, listener: (event: SocketEvent) => void): void
}

/**
 * Holds one device socket until it closes, goes quiet or `signal` aborts.
 * `onWork` runs once when the socket opens and again on each `work` signal,
 * one at a time; a burst during a read needs one more read. A failed `onWork`
 * closes the socket: the redial's first read retries it. The ping is an
 * application frame the gateway answers without touching the database.
 */
export function runDeviceGateway(socket: DeviceGatewaySocket, options: {
  signal: AbortSignal
  onOpen?: () => void
  /** Synchronous invalidation is independent of a slow command drain. */
  onWorkAvailable?: () => void
  onWork: () => Promise<void>
  pingMs?: number
  silenceMs?: number
}): Promise<void> {
  const pingMs = options.pingMs ?? DEVICE_GATEWAY_PING_MS
  const silenceMs = options.silenceMs ?? DEVICE_GATEWAY_SILENCE_MS
  return new Promise((resolve, reject) => {
    let settled = false
    let opened = false
    let pulling = false
    let pendingWork = false
    let lastMessage = 0
    let ping: ReturnType<typeof setInterval> | undefined
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearInterval(ping)
      clearTimeout(handshake)
      options.signal.removeEventListener("abort", abort)
      for (const [type, listener] of listeners) socket.removeEventListener?.(type, listener)
      try { socket.close() } catch { /* already closed */ }
      if (error && !options.signal.aborted) reject(error)
      else resolve()
    }
    const work = () => {
      if (settled) return
      pendingWork = true
      if (pulling) return
      pulling = true
      void (async () => {
        while (pendingWork && !settled) {
          pendingWork = false
          await options.onWork()
        }
      })().catch(error => finish(error instanceof Error ? error : new Error(String(error))))
        .finally(() => {
          pulling = false
          if (pendingWork && !settled) work()
        })
    }
    const abort = () => finish()
    const signalWork = () => {
      if (settled) return
      try { options.onWorkAvailable?.(); work() }
      catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
    }
    const listeners: [SocketEventType, (event: SocketEvent) => void][] = [
      ["open", () => {
        if (settled || opened) return
        opened = true
        clearTimeout(handshake)
        lastMessage = performance.now()
        options.onOpen?.()
        ping = setInterval(() => {
          if (performance.now() - lastMessage >= silenceMs) {
            finish(new Error("device gateway went quiet"))
            return
          }
          try { if (socket.readyState === 1) socket.send(DEVICE_GATEWAY_PING) }
          catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
        }, pingMs)
        signalWork()
      }],
      ["message", event => {
        if (!opened || settled) return
        lastMessage = performance.now()
        if (event.data === "work") signalWork()
      }],
      ["close", event => finish(new DeviceGatewayClosedError(event.code))],
      ["error", () => finish(new Error("device gateway failed"))],
    ]
    const handshake = setTimeout(() => finish(new Error("device gateway handshake timed out")), DEVICE_GATEWAY_HANDSHAKE_MS)
    for (const [type, listener] of listeners) socket.addEventListener(type, listener)
    options.signal.addEventListener("abort", abort, { once: true })
    if (options.signal.aborted) finish()
  })
}

export function openDeviceGateway(url: string, protocol: string): DeviceGatewaySocket {
  const Socket = (globalThis as unknown as { WebSocket: new (url: string, protocols: string[]) => DeviceGatewaySocket }).WebSocket
  return new Socket(url, [protocol])
}

/** The wait before redial number `failures` (1-based): doubling from 0.5 s to 30 s, half of it jittered. */
export function deviceGatewayRetryDelay(failures: number, random: () => number = Math.random): number {
  const ceiling = Math.min(DEVICE_GATEWAY_RETRY_MAX_MS, DEVICE_GATEWAY_RETRY_MIN_MS * 2 ** Math.max(0, failures - 1))
  return Math.max(DEVICE_GATEWAY_RETRY_MIN_MS, ceiling * (0.5 + random() * 0.5))
}

/** What the session does after a socket attempt ended with `error`. */
export type DeviceSessionVerdict = "redial" | "slow" | "stop"

export interface DeviceSessionOptions {
  /** Mints a ticket for the next socket (registering first if needed). It may wait, e.g. for a credential. */
  ticket(signal: AbortSignal): Promise<{ url: string; protocol: string }>
  open?(url: string, protocol: string): DeviceGatewaySocket
  onOpen(): void
  /** After every attempt, opened or not, with what ended it. */
  onClose(error: unknown, opened: boolean): void
  onWorkAvailable?(): void
  onWork(signal: AbortSignal): Promise<void>
  /** `stop` ends the session for good; `slow` waits the longest delay; anything else redials with backoff. */
  verdict?(error: unknown): DeviceSessionVerdict
  random?: () => number
}

/**
 * The daemon's one session loop: ticket, socket, read on open and on each
 * push, and on any loss a redial after a jittered backoff. Nothing else talks
 * to the server on a timer.
 */
export class DeviceSession {
  private readonly stopped = new AbortController()
  private attempt: AbortController | null = null
  private wakeUp: (() => void) | null = null
  private skipBackoff = false
  private loop: Promise<void> | null = null

  private readonly options: DeviceSessionOptions

  constructor(options: DeviceSessionOptions) { this.options = options }

  start(): Promise<void> {
    return (this.loop ??= this.run())
  }

  /**
   * Close the current socket and dial again: after the usual backoff, or at
   * once with `now` (the credential changed, so the old backoff means nothing).
   */
  redial(now = false) {
    if (now) { this.skipBackoff = true; this.wakeUp?.() }
    this.attempt?.abort()
  }

  /** Cut a backoff wait short: something the next attempt needed just arrived. */
  wake() { this.wakeUp?.() }

  stop(): Promise<void> {
    this.stopped.abort()
    this.attempt?.abort()
    this.wakeUp?.()
    return this.loop ?? Promise.resolve()
  }

  private async run() {
    let failures = 0
    const { signal } = this.stopped
    while (!signal.aborted) {
      this.skipBackoff = false
      const attempt = new AbortController()
      this.attempt = attempt
      let openedAt: number | undefined
      let failure: unknown
      try {
        const { url, protocol } = await this.options.ticket(attempt.signal)
        if (attempt.signal.aborted) throw new DeviceGatewayClosedError()
        const socket = (this.options.open ?? openDeviceGateway)(url, protocol)
        await runDeviceGateway(socket, {
          signal: attempt.signal,
          onOpen: () => { openedAt = performance.now(); this.options.onOpen() },
          onWorkAvailable: this.options.onWorkAvailable,
          onWork: () => this.options.onWork(attempt.signal),
        })
        failure = new DeviceGatewayClosedError()
      } catch (error) {
        failure = error
      } finally {
        attempt.abort()
        if (this.attempt === attempt) this.attempt = null
      }
      this.options.onClose(failure, openedAt !== undefined)
      if (signal.aborted) return
      const verdict = this.options.verdict?.(failure) ?? "redial"
      if (verdict === "stop") return
      if (openedAt !== undefined && performance.now() - openedAt >= DEVICE_GATEWAY_STABLE_MS) failures = 0
      if (this.skipBackoff) { this.skipBackoff = false; failures = 0; continue }
      failures = Math.min(failures + 1, 32)
      await this.pause(verdict === "slow" ? DEVICE_GATEWAY_RETRY_MAX_MS : deviceGatewayRetryDelay(failures, this.options.random))
    }
  }

  /** A redial backoff, not a poll: it ends early on `wake` or `stop`. */
  private pause(ms: number): Promise<void> {
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); this.wakeUp = null; resolve() }
      const timer = setTimeout(done, ms)
      this.wakeUp = done
      if (this.stopped.signal.aborted) done()
    })
  }
}
