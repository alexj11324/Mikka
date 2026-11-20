import { AsyncLocalStorage } from 'node:async_hooks'

// Nitro and the World adapter may load separate bundles inside the same Node
// process. Both must see the authorized session during the native hook resume.
const key = Symbol.for('mikka.eve.session-control-delivery')
const scope = globalThis[key] ??= new AsyncLocalStorage()

export function withSessionControlDelivery(route, sessionId, deliver) {
  if (route.method === 'POST' && (route.path === '/eve/v1/session/:sessionId/cancel' ||
      route.path === '/eve/v1/session/:sessionId/end')) {
    return scope.run(sessionId, deliver)
  }
  return deliver()
}

export function isSessionControlWake(message) {
  const sessionId = scope.getStore()
  return typeof sessionId === 'string' && message?.runId === sessionId && !!message.hookResumeTiming
}
