// Test-only network boundary. The production entry never imports this file.
import { parentPort, workerData } from 'node:worker_threads'
const sockets = []
class OfflineSocket {
  readyState = 0
  listeners = new Map()
  onopen = null; onclose = null; onerror = null; onmessage = null
  constructor() {
    sockets.push(this)
    queueMicrotask(() => {
      this.readyState = 1; this.emit('open', {})
      this.message({ type: 'live_ready', version: 2, kinds: ['device_list', 'thread_list'], revisions: ['device_list', 'thread_list'] })
      this.message({ type: 'presence_ready', version: 1 })
    })
  }
  addEventListener(type, callback) {
    const values = this.listeners.get(type) ?? []; values.push(callback); this.listeners.set(type, values)
  }
  emit(type, value) { for (const listener of this.listeners.get(type) ?? []) listener(value); this['on' + type]?.(value) }
  message(value) { this.emit('message', { data: typeof value === 'string' ? value : JSON.stringify(value) }) }
  send(value) {
    if (value === 'ping') { queueMicrotask(() => this.message('pong')); return }
    const command = JSON.parse(value)
    if (command.type === 'presence_watch' && !workerData.suppressAck) queueMicrotask(() => this.message({
      type: 'presence_ack', id: command.id, expiresAt: workerData.initialRead.live.presence.expiresAt }))
  }
  close() { this.readyState = 3; queueMicrotask(() => this.emit('close', {})) }
}
globalThis.WebSocket = OfflineSocket
globalThis.fetch = () => { throw new Error('offline_network_forbidden') }
parentPort.on('message', message => {
  if (message?.type !== 'test-push') return
  for (const socket of sockets) {
    socket.message({ kind: 'device_list', id: workerData.home })
    socket.message({ kind: 'thread_list', id: workerData.home })
  }
})
await import('./presence-worker.mjs')
