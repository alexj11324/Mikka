// Exact old DevicesSettings adapter: actual old LiveChannels, one home key and
// a conditional null-scope fallback key. There is deliberately no TabShare.
import { parentPort, workerData } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'
const { sourceDirectory, tabId, ownerId, home, fixtureId, initialRead } = workerData
const source = path => import(pathToFileURL(sourceDirectory + '/' + path).href)
const [{ LiveChannels }, { liveInvalidation, liveReadiness }] = await Promise.all([
  source('lib/live/channels.mjs'), source('lib/live/events.mjs'),
])
const key = 'devices-settings', unresolved = '00000000-0000-4000-8000-000000000000'
const pending = new Map(), timers = new Set()
let next = 0, closing = false, mainSubscription, fallbackSubscription, channels
let current = { ...initialRead, requestedAt: performance.now() }, activeRefreshes = 0, firstReadSettled = false, transportReady = false
const metadata = { refreshCalls: 0, networkReads: 0, devicePushes: 0, threadPushes: 0, socketCount: 0, nullTicketAttempts: 0 }
const post = value => parentPort.postMessage({ ...value, tabId })
const state = () => post({ type: 'state', ...metadata, activeRefreshes, ready: transportReady && firstReadSettled,
  online: current.devices.find(row => row.id === fixtureId)?.online, fallbackActive: !!fallbackSubscription })
const request = (method, signal) => new Promise((resolve, reject) => {
  const id = ++next
  const abort = () => { pending.delete(id); post({ type: 'cancel', id }); reject(new Error('presence_baseline_aborted')) }
  if (closing || signal?.aborted) { abort(); return }
  signal?.addEventListener('abort', abort, { once: true })
  pending.set(id, { resolve(value) { signal?.removeEventListener('abort', abort); resolve(value) },
    reject() { signal?.removeEventListener('abort', abort); reject(new Error('presence_baseline_parent_failed')) } })
  post({ type: 'request', id, method })
})
const options = () => {
  const deadline = current.live?.deadline
  const elapsed = Number.isFinite(current.requestedAt) ? Math.max(0, performance.now() - current.requestedAt) : Infinity
  return { minIntervalMs: 2_000, deadline: deadline ? { ...deadline, afterMs: Math.max(0, deadline.afterMs - elapsed), observation: current.requestedAt } : undefined }
}
function update() {
  mainSubscription?.update(options())
  // Same conditional as the exact old component, updated from its real read.
  if (current.presenceFallback && !fallbackSubscription) fallbackSubscription = channels.subscribe(null, 'device_list', unresolved, [key], refresh, { minIntervalMs: 2_000 })
  else if (!current.presenceFallback && fallbackSubscription) { fallbackSubscription(); fallbackSubscription = undefined }
  state()
}
async function refresh(requestedKey) {
  if (closing || requestedKey !== key) return
  metadata.refreshCalls++; metadata.networkReads++; activeRefreshes++; state()
  const requestedAt = performance.now()
  try {
    const value = await request('devices')
    if (closing) return
    if (value?.live?.ownerId !== ownerId || value.live.workspaceId !== home || !Array.isArray(value.devices)
      || !value.devices.some(row => row.id === fixtureId)) throw new Error('presence_baseline_scope_invalid')
    current = { ...value, requestedAt }; update()
  } catch { fatal() }
  finally { activeRefreshes--; firstReadSettled = true; state() }
}
function dispose() {
  if (closing) return
  closing = true; mainSubscription?.(); fallbackSubscription?.(); channels?.dispose()
  for (const timer of timers) clearTimeout(timer)
  timers.clear()
  for (const [id, waiter] of pending) { post({ type: 'cancel', id }); waiter.reject() }
  pending.clear()
}
function fatal() { if (!closing) { post({ type: 'fatal' }); dispose() } }
channels = new LiveChannels(scope => ({
  ticket: signal => { if (!scope) { metadata.nullTicketAttempts++; return Promise.resolve(null) } return request('ticket', signal) },
  socket(ticket) {
    if (++metadata.socketCount !== 1) { fatal(); throw new Error('presence_baseline_reconnect_outside_case') }
    const socket = new WebSocket(ticket.url, ticket.protocol)
    socket.addEventListener('message', message => {
      if (closing || typeof message.data !== 'string' || message.data.length > 2_048 || message.data === 'pong') return
      let parsed
      try { parsed = JSON.parse(message.data) } catch { return }
      const readiness = liveReadiness(parsed)
      if (readiness) transportReady = readiness.kinds.includes('device_list')
      const event = liveInvalidation(parsed, true)
      if (event?.id === home) {
        if (event.kind === 'device_list') metadata.devicePushes++
        if (event.kind === 'thread_list') metadata.threadPushes++
      }
      queueMicrotask(state)
    })
    socket.addEventListener('error', fatal); socket.addEventListener('close', () => { if (!closing) fatal() })
    return socket
  },
  visible: () => !closing, watchVisibility: () => () => {}, now: Date.now, monotonicNow: () => performance.now(),
  later(callback, milliseconds) { const timer = setTimeout(() => { timers.delete(timer); callback() }, milliseconds); timers.add(timer); return timer },
  cancel(timer) { clearTimeout(timer); timers.delete(timer) },
}))
parentPort.on('message', message => {
  if (message?.type === 'response' && Number.isSafeInteger(message.id)) {
    const waiter = pending.get(message.id); if (!waiter) return
    pending.delete(message.id); if (message.ok) waiter.resolve(message.value); else waiter.reject()
  } else if (message?.type === 'close') {
    dispose(); post({ type: 'closed', ...metadata, activeRefreshes }); parentPort.close()
  }
})
mainSubscription = channels.subscribe(home, 'device_list', home, [key], refresh, options())
update()
