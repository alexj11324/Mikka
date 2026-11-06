// Test-only virtual clock and WebSocket boundary. Actual old LiveChannels run.
import { mock } from 'node:test'
import { parentPort, workerData } from 'node:worker_threads'
mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
const start = Date.now()
mock.method(performance, 'now', () => Date.now() - start)
const sockets = []
class OfflineSocket {
  readyState = 0; listeners = new Map()
  onopen = null; onclose = null; onerror = null; onmessage = null
  constructor() { sockets.push(this); queueMicrotask(() => { this.readyState = 1; this.emit('open', {}); this.message({ type: 'live_ready', version: 1, kinds: ['device_list', 'thread_list'] }) }) }
  addEventListener(type, callback) { const values = this.listeners.get(type) ?? []; values.push(callback); this.listeners.set(type, values) }
  emit(type, value) { for (const callback of this.listeners.get(type) ?? []) callback(value); this['on' + type]?.(value) }
  message(value) { this.emit('message', { data: typeof value === 'string' ? value : JSON.stringify(value) }) }
  send(value) { if (value !== 'ping') throw new Error('baseline_sent_new_presence_protocol'); if (!workerData.suppressPongs) queueMicrotask(() => this.message('pong')) }
  close() { if (this.readyState === 3) return; this.readyState = 3; queueMicrotask(() => this.emit('close', { code: 1000, wasClean: true })) }
}
globalThis.WebSocket = OfflineSocket
globalThis.fetch = () => { throw new Error('offline_network_forbidden') }
parentPort.on('message', async message => {
  if (message?.type === 'test-socket-close') {
    for (const socket of sockets) { socket.readyState = 3; socket.emit('close', { code: 1011, wasClean: true, reason: message.sensitive }) }
    parentPort.postMessage({ type: 'offline-fault-injected', tabId: workerData.tabId }); return
  }
  if (message?.type === 'test-socket-error') {
    for (const socket of sockets) socket.emit('error', { message: message.sensitive, error: new Error(message.sensitive) })
    parentPort.postMessage({ type: 'offline-fault-injected', tabId: workerData.tabId }); return
  }
  if (message?.type !== 'test-advance') return
  // Let each real callback's microtasks run before the next virtual second.
  for (let elapsed = 0; elapsed < message.ms; elapsed += 100) { mock.timers.tick(Math.min(100, message.ms - elapsed)); await new Promise(resolve => setImmediate(resolve)) }
  parentPort.postMessage({ type: 'offline-clock-advanced', tabId: workerData.tabId, id: message.id })
})
await import('./presence-baseline-worker.mjs')
parentPort.postMessage({ type: 'offline-clock-ready', tabId: workerData.tabId })
