/** Text the Durable Object answers without waking. See cloudflare/device-gateway/src/session.ts. */
export const DEVICE_GATEWAY_PING = "ping"
export const DEVICE_GATEWAY_PING_MS = 30_000
export const DEVICE_GATEWAY_HANDSHAKE_MS = 10_000
export const DEVICE_GATEWAY_PONG_TIMEOUT_MS = 90_000

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
 * Holds one device socket. `onWork` runs on connect and on each `work` signal,
 * one at a time. The 30s ping is an application frame the object auto-answers;
 * it does not mean new work and it does not touch the database.
 */
export function runDeviceGateway(socket: DeviceGatewaySocket, options: {
  signal: AbortSignal
  onOpen?: () => void
  /** Synchronous invalidation is independent of a slow command drain. */
  onWorkAvailable?: () => void
  onWork: () => Promise<void>
  pingMs?: number
}): Promise<void> {
  const pingMs = options.pingMs ?? DEVICE_GATEWAY_PING_MS
  return new Promise((resolve, reject) => {
    let settled = false
    let opened = false
    let pulling = false
    let pendingWork = false
    let lastPong = 0
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
      // A burst while a read is in flight needs just one further drain. A
      // failed drain must leave push mode so HTTP fallback can retry it.
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
        lastPong = performance.now()
        options.onOpen?.()
        ping = setInterval(() => {
          if (performance.now() - lastPong >= DEVICE_GATEWAY_PONG_TIMEOUT_MS) {
            finish(new Error("device gateway pong timed out"))
            return
          }
          try { if (socket.readyState === 1) socket.send(DEVICE_GATEWAY_PING) }
          catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
        }, pingMs)
        signalWork()
      }],
      ["message", event => {
        if (!opened || settled) return
        if (event.data === "pong") lastPong = performance.now()
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
