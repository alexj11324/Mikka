// One independent core consumer. Only the parent holds the normal app session.
// No body, device name, signed proof, ticket or credential is emitted as evidence.
import { parentPort, workerData } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'

const { sourceDirectory, tabId, ownerId, home, build, fixtureId, initialRead } = workerData
const source = path => import(pathToFileURL(sourceDirectory + '/' + path).href)
const [{ LiveChannel }, { TabShare, tabShareChannelName }, { coversLiveRevisions, heldRevision },
  { liveInvalidation, liveReadiness }, { presenceReply }, { PersistentReadCache, readCacheShareNamespace }] = await Promise.all([
  source('lib/live/channel.mjs'), source('lib/live/tab-share.mjs'), source('lib/live/revisions.mjs'),
  source('lib/live/events.mjs'), source('lib/live/presence.mjs'), source('lib/swr/persistent-cache.mjs'),
])
const key = 'devices-settings'
const pending = new Map(), timers = new Set()
let nextRequest = 0, closing = false, firstReadSettled = false, transportReady = false
let subscription, channel, tabs, disconnectCache, activeRefreshes = 0, socketCount = 0
const metadata = { refreshCalls: 0, networkReads: 0, adopted: 0, rejectedOlderResults: 0,
  devicePushes: 0, threadPushes: 0, acknowledgements: 0, watches: 0, unwatches: 0, socketCount: 0 }
const post = value => parentPort.postMessage({ ...value, tabId })
const noDisk = { async activate() { return [] }, async write() {}, async remove() {}, async clear() {} }
const cache = new PersistentReadCache({ userId: ownerId, workspaceId: home, build, role: 'admin' }, noDisk)
const namespace = readCacheShareNamespace(cache, ownerId)
const validRead = data => data?.live?.ownerId === ownerId && data.live.workspaceId === home
  && Array.isArray(data.devices) && data.devices.some(row => row.id === fixtureId && typeof row.online === 'boolean')
if (!namespace || !validRead(initialRead)) throw new Error('presence_worker_scope_invalid')
cache.set(key, { data: { ...initialRead, requestedAt: performance.now() }, _k: key })
const online = () => cache.get(key)?.data?.devices.find(row => row.id === fixtureId)?.online
const state = () => post({ type: 'state', ...metadata, activeRefreshes, online: online(),
  covered: channel?.keyConnected(key) === true,
  ready: transportReady && firstReadSettled && channel?.keyConnected(key) === true,
  namespace })

function request(method, signal) {
  if (closing) return Promise.reject(new Error('presence_consumer_closed'))
  const id = ++nextRequest
  return new Promise((resolve, reject) => {
    const abort = () => { pending.delete(id); post({ type: 'cancel', id }); reject(new Error('presence_request_aborted')) }
    if (signal?.aborted) { abort(); return }
    signal?.addEventListener('abort', abort, { once: true })
    pending.set(id, { resolve(value) { signal?.removeEventListener('abort', abort); resolve(value) },
      reject() { signal?.removeEventListener('abort', abort); reject(new Error('presence_parent_request_failed')) } })
    post({ type: 'request', id, method })
  })
}

function options(data) {
  const deadline = data.live?.deadline
  const elapsed = Number.isFinite(data.requestedAt) ? Math.max(0, performance.now() - data.requestedAt) : Infinity
  return { minIntervalMs: 2_000, presence: data.live.presence,
    revisions: { [key]: heldRevision(data, 'device_list', home) },
    deadline: deadline ? { ...deadline, afterMs: Math.max(0, deadline.afterMs - elapsed), observation: data.requestedAt } : undefined }
}

function storeSnapshot(data) {
  if (!validRead(data)) throw new Error('presence_snapshot_scope_invalid')
  cache.set(key, { data, _k: key })
  subscription?.update(options(data)); state()
  return data
}

function dispose() {
  if (closing) return
  // Unsubscribe while the socket is live: real presence_unwatch precedes close.
  subscription?.(); closing = true
  channel?.dispose(); tabs?.close(); disconnectCache?.(); cache.invalidate(false)
  for (const timer of timers) clearTimeout(timer)
  timers.clear()
  for (const [id, waiter] of pending) { post({ type: 'cancel', id }); waiter.reject() }
  pending.clear()
}
function fatal() { if (!closing) { post({ type: 'fatal', code: 'presence_worker_failed' }); dispose() } }
disconnectCache = cache.connect(fatal)
tabs = new TabShare(tabShareChannelName(namespace, home))

// Mirrors the reviewed hook's namespace, revision and local-write identity checks;
// the actual LiveChannel, TabShare and PersistentReadCache algorithms are imported.
async function refresh(requestedKey, requiredRevisions, reuseCompleted) {
  if (closing || requestedKey !== key) return
  metadata.refreshCalls++; activeRefreshes++; post({ type: 'refresh' }); state()
  const mutate = async (data, revalidate = true) => {
    if (!revalidate) return storeSnapshot(data)
    metadata.networkReads++
    const requestedAt = performance.now(), next = await request('devices')
    if (!closing) return storeSnapshot({ ...next, requestedAt })
  }
  try {
    const authorized = () => readCacheShareNamespace(cache, ownerId) === namespace
    if (!authorized()) return await mutate()
    const previous = cache.get(key)?.data
    const accepts = data => {
      const accepted = coversLiveRevisions(data, requiredRevisions) && coversLiveRevisions(data, cache.get(key)?.data?.live?.revisions)
      if (!accepted) metadata.rejectedOlderResults++
      return accepted
    }
    return await tabs.run(key, () => mutate(), data => {
      if (!authorized()) return
      if (cache.get(key)?.data !== previous) return mutate()
      metadata.adopted++; post({ type: 'adopt' }); return mutate(data, false)
    }, accepts, reuseCompleted)
  } catch { fatal() }
  finally { activeRefreshes--; firstReadSettled = true; state() }
}

channel = new LiveChannel({
  ticket: signal => request('ticket', signal),
  socket(ticket) {
    if (++socketCount !== 1) { fatal(); throw new Error('presence_reconnect_outside_case') }
    metadata.socketCount = socketCount
    const socket = new WebSocket(ticket.url, ticket.protocol)
    const send = socket.send.bind(socket)
    socket.send = value => {
      if (value !== 'ping') {
        const frame = JSON.parse(value)
        if (frame.type === 'presence_watch') metadata.watches++
        if (frame.type === 'presence_unwatch') metadata.unwatches++
      }
      send(value)
    }
    socket.addEventListener('message', message => {
      if (closing || typeof message.data !== 'string' || message.data.length > 2_048 || message.data === 'pong') return
      let parsed
      try { parsed = JSON.parse(message.data) } catch { return }
      const readiness = liveReadiness(parsed)
      if (readiness) transportReady = readiness.kinds.includes('device_list') && readiness.kinds.includes('thread_list')
      const presence = presenceReply(parsed)
      if (presence?.type === 'presence_ack') { metadata.acknowledgements++; post({ type: 'ack' }) }
      if (presence?.type === 'presence_unavailable') { post({ type: 'unavailable' }); fatal(); return }
      const event = liveInvalidation(parsed, true)
      if (event?.id.toLowerCase() === home.toLowerCase() && ['device_list', 'thread_list'].includes(event.kind)) {
        if (event.kind === 'device_list') metadata.devicePushes++; else metadata.threadPushes++
        post({ type: 'push', kind: event.kind })
      }
      queueMicrotask(state) // LiveChannel receives the same frame before coverage is reported.
    })
    socket.addEventListener('error', fatal)
    socket.addEventListener('close', () => { if (!closing) fatal() })
    return socket
  },
  visible: () => !closing, watchVisibility: () => () => {}, now: Date.now,
  monotonicNow: () => performance.now(),
  later(callback, milliseconds) { const timer = setTimeout(() => { timers.delete(timer); callback() }, milliseconds); timers.add(timer); return timer },
  cancel(timer) { clearTimeout(timer); timers.delete(timer) },
})
parentPort.on('message', message => {
  if (message?.type === 'response' && Number.isSafeInteger(message.id)) {
    const waiter = pending.get(message.id); if (!waiter) return
    pending.delete(message.id); if (message.ok) waiter.resolve(message.value); else waiter.reject()
  } else if (message?.type === 'close') {
    dispose(); post({ type: 'closed', ...metadata, activeRefreshes }); parentPort.close()
  }
})
subscription = channel.subscribe('device_list', home, [key], refresh, options(cache.get(key).data))
