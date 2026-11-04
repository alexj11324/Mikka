import assert from "node:assert/strict"
import test from "node:test"
import { DEVICE_GATEWAY_PING, runDeviceGateway, type DeviceGatewaySocket } from "../src/device-gateway.ts"

class FakeSocket implements DeviceGatewaySocket {
  readyState = 1
  sent: string[] = []
  listeners = new Map<string, ((event: { data?: unknown }) => void)[]>()
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: { data?: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }
  send(data: string) { this.sent.push(data) }
  close() { this.readyState = 3 }
  emit(type: "open" | "message" | "close" | "error", data?: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener({ data })
  }
}

test("connect and a work signal each pull once, and a ping is not work", async () => {
  const socket = new FakeSocket()
  const pulls: string[] = []
  const signal = new AbortController()
  const done = runDeviceGateway(socket, { signal: signal.signal, pingMs: 60_000, onWork: async () => { pulls.push("pull") } })
  socket.emit("open")
  socket.emit("message", DEVICE_GATEWAY_PING)
  socket.emit("message", "work")
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(pulls, ["pull", "pull"])
  signal.abort()
  await done
})
