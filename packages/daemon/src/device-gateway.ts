/** Text the Durable Object answers without waking. See cloudflare/device-gateway/src/session.ts. */
export const DEVICE_GATEWAY_PING = "ping"
export const DEVICE_GATEWAY_PING_MS = 30_000

export interface DeviceGatewaySocket {
  readyState: number
  send(data: string): void
  close(): void
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown }) => void): void
}

/**
 * Holds one device socket. `onWork` runs on connect and on each `work` signal,
 * one at a time. The 30s ping is an application frame the object auto-answers;
 * it does not mean new work and it does not touch the database.
 */
export function runDeviceGateway(socket: DeviceGatewaySocket, options: { signal: AbortSignal; onWork: () => Promise<void>; pingMs?: number }): Promise<void> {
  const pingMs = options.pingMs ?? DEVICE_GATEWAY_PING_MS
  return new Promise((resolve, reject) => {
    let chain = Promise.resolve()
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearInterval(ping)
      try { socket.close() } catch { /* already closed */ }
      if (error && !options.signal.aborted) reject(error)
      else resolve()
    }
    const ping = setInterval(() => {
      if (socket.readyState === 1) socket.send(DEVICE_GATEWAY_PING)
    }, pingMs)
    const work = () => {
      chain = chain.then(() => options.onWork()).catch(() => undefined)
    }
    options.signal.addEventListener("abort", () => finish(), { once: true })
    socket.addEventListener("open", () => work())
    socket.addEventListener("message", event => { if (event.data === "work") work() })
    socket.addEventListener("close", () => finish(new Error("device gateway closed")))
    socket.addEventListener("error", () => finish(new Error("device gateway failed")))
  })
}

export function openDeviceGateway(url: string, protocol: string): DeviceGatewaySocket {
  const Socket = (globalThis as unknown as { WebSocket: new (url: string, protocols: string[]) => DeviceGatewaySocket }).WebSocket
  return new Socket(url, [protocol])
}
