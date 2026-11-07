// Test-only platform fixture. Production never imports or invokes this module.
import { parentPort } from 'node:worker_threads'
globalThis.fetch = () => { throw new Error('network_forbidden') }
const sockets = new Set()
globalThis.WebSocket = class extends EventTarget {
  readyState = 0
  constructor(url, protocol) {
    super()
    if (!url.startsWith('wss://offline.invalid/') || typeof protocol !== 'string') throw new Error('offline_socket_scope')
    const query = new URL(url).searchParams
    if (query.get('revisions') !== '1' || query.get('presence') !== '1') throw new Error('offline_capability_request_missing')
    sockets.add(this)
    queueMicrotask(() => {
      this.readyState = 1; this.onopen?.(new Event('open'))
      this.packet({ type: 'live_ready', version: 2, kinds: ['bot_chat'], revisions: ['bot_chat'] })
      this.packet({ type: 'presence_ready', version: 1 })
    })
  }
  packet(value) {
    const event = new MessageEvent('message', { data: JSON.stringify(value) })
    this.dispatchEvent(event); this.onmessage?.(event)
  }
  send(value) { if (value !== 'ping') throw new Error('offline_socket_write') }
  close() { if (this.readyState === 3) return; this.readyState = 3; sockets.delete(this); this.dispatchEvent(new Event('close')); this.onclose?.(new Event('close')) }
}
parentPort.on('message', message => {
  if (message?.type === 'fixture-push') for (const socket of sockets) socket.packet({ kind: 'bot_chat', id: message.botId, rev: message.revision })
  if (message?.type === 'fixture-disconnect') for (const socket of sockets) socket.close()
})
await import('./live-worker.mjs')
