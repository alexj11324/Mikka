// Private fork transport. The same backend serves the existing stdio entry.
// Only the parent has this IPC channel; no listener, URL or token in argv.
import { prepareMikkaMcpBackend } from './mikka-mcp-backend.mjs'

let backend, consumed = false, closed = false
const lifetime = new AbortController()
const send = message => { if (process.connected) process.send(message, () => {}) }
const close = () => {
  if (closed) return
  closed = true
  lifetime.abort()
  void Promise.resolve(backend?.close()).catch(() => {}).finally(() => process.disconnect?.())
}
process.on('disconnect', close)
process.on('SIGTERM', close)
process.on('message', async message => {
  if (!message || typeof message !== 'object' || !Number.isSafeInteger(message.id) || message.id < 1) return
  const { id, operation } = message
  try {
    if (closed) throw Error('MCP worker closed')
    if (operation === 'bind') {
      if (consumed) throw Error('MCP worker already bound')
      consumed = true
      backend = prepareMikkaMcpBackend(message.profile)
      await backend.bind(message.context, { signal: lifetime.signal, assertLive() { lifetime.signal.throwIfAborted() } })
      if (closed) throw Error('MCP worker closed')
      send({ id, result: true })
    } else if (operation === 'call') {
      if (!backend || !consumed) throw Error('MCP worker unbound')
      const result = await backend.handle(message.request)
      if (closed) throw Error('MCP worker closed')
      send({ id, result })
    } else throw Error('MCP worker operation unavailable')
  } catch {
    // Original tool results remain in result; transport failures never expose
    // exception messages, argv, environment or credentials.
    send({ id, error: 'mcp_worker_unavailable' })
  }
})
