// One real core consumer per Node worker: separate heap, cache and live socket.
// The parent alone holds the normal authenticated session. Never log packets/data.
import { parentPort, workerData } from 'node:worker_threads'
import { pathToFileURL } from 'node:url'

const { sourceDirectory, tabId, ownerId, workspaceId, transportScope, build, botId, initialChat } = workerData
const source = path => import(pathToFileURL(sourceDirectory + '/' + path).href)
const [{ LiveChannel }, { TabShare, tabShareChannelName }, { coversLiveRevisions, heldRevision },
  { liveInvalidation, liveReadiness }, { PersistentReadCache, readCacheShareNamespace },
  { readBoundary, readFresh, observeSWRRead, acceptSWRRead, failSWRRead }] = await Promise.all([
  source('lib/live/channel.mjs'), source('lib/live/tab-share.mjs'), source('lib/live/revisions.mjs'),
  source('lib/live/events.mjs'), source('lib/swr/persistent-cache.mjs'), source('lib/swr/read-observer.mjs'),
])
const entity = 'bot_chat:' + botId.toLowerCase()
// A deterministic serialized cache key for the core harness; no React/SWR render is claimed.
const key = JSON.stringify(['coordinator-chat', botId])
const pending = new Map(), timers = new Set()
let nextRequest = 0, closing = false, readySent = false, transportReady = false, firstReadSettled = false
let subscription, channel, tabs, disconnectCache, activeRefreshes = 0, socketCount = 0
const metadata = { tabId, refreshCalls: 0, networkReads: 0, adopted: 0, rejectedOlderResults: 0,
  pushes: 0, versionedPushes: 0, socketCount: 0, latestRevision: heldRevision(initialChat, 'bot_chat', botId) ?? 0 }
const post = value => parentPort.postMessage({ ...value, tabId })
const revision = data => heldRevision(data, 'bot_chat', botId) ?? 0
const emitState = () => post({ type: 'state', ...metadata, activeRefreshes })
const fail = code => { throw new Error(code) }

function request(method, detail = {}, signal) {
  if (closing) return Promise.reject(new Error('live_consumer_closed'))
  const id = ++nextRequest
  return new Promise((resolve, reject) => {
    const abort = () => { pending.delete(id); post({ type: 'cancel', id }); reject(new Error('live_request_aborted')) }
    if (signal?.aborted) { abort(); return }
    signal?.addEventListener('abort', abort, { once: true })
    pending.set(id, { resolve(value) { signal?.removeEventListener('abort', abort); resolve(value) },
      reject() { signal?.removeEventListener('abort', abort); reject(new Error('live_parent_request_failed')) } })
    post({ type: 'request', id, method, ...detail })
  })
}

function tryReady() {
  if (!readySent && transportReady && firstReadSettled && !closing) {
    readySent = true; post({ type: 'ready', namespace, latestRevision: metadata.latestRevision }); emitState()
  }
}

function dispose() {
  if (closing) return
  closing = true
  subscription?.(); channel?.dispose(); tabs?.close(); disconnectCache?.()
  cache.invalidate(false)
  for (const timer of timers) clearTimeout(timer)
  timers.clear()
  for (const [id, waiter] of pending) { post({ type: 'cancel', id }); waiter.reject() }
  pending.clear()
}

function fatal() {
  if (closing) return
  post({ type: 'fatal', code: 'live_worker_failed' }); dispose()
}

const noDisk = { async activate() { return [] }, async write() {}, async remove() {}, async clear() {} }
const cache = new PersistentReadCache({ userId: ownerId, workspaceId, build, role: 'admin' }, noDisk)
const namespace = readCacheShareNamespace(cache, ownerId)
if (!namespace || initialChat.botId !== botId || initialChat.live?.ownerId !== ownerId || initialChat.live?.workspaceId !== transportScope) fail('live_worker_scope_invalid')
cache.set(key, { data: { ...initialChat, requestedAt: performance.now() }, _k: ['coordinator-chat', botId] })
disconnectCache = cache.connect(fatal)
tabs = new TabShare(tabShareChannelName(namespace, transportScope))

function storeSnapshot(data) {
  if (data?.botId !== botId || data.live?.ownerId !== ownerId || data.live?.workspaceId !== transportScope) fail('live_snapshot_scope_invalid')
  cache.set(key, { data, _k: ['coordinator-chat', botId] })
  metadata.latestRevision = revision(data)
  subscription?.update({ minIntervalMs: 2_000, revisions: { [key]: metadata.latestRevision } })
  emitState(); return data
}

// This adapter preserves the production observeSWRRead -> onSuccess -> cache
// commit order. It is a normalized RPC consumer, not a React/SWR render.
const current = () => !closing && cache.isEnabled

// Used by the real refresh path; the offline platform fixture can independently
// start this same actual read to exercise an in-flight same-realm obligation.
export function readSnapshot(requiredRevision = 0, reuseCompleted = false) {
  const promise = observeSWRRead(cache, key, async () => {
    metadata.networkReads++
    const requestedAt = performance.now()
    const next = await request('chat', { requiredRevision, reuseCompleted: reuseCompleted === true })
    return { ...next, requestedAt }
  })
  return promise.then(data => {
    if (!current()) return
    try {
      acceptSWRRead(cache, key, data)
      return storeSnapshot(data)
    } catch (error) {
      failSWRRead(cache, key, data, error)
      throw error
    }
  })
}

// Same current-lifetime, authorization, required/held/local revision and
// local-write identity guards as the pinned use-live-key refresh closure.
async function refresh(requestedKey, requiredRevisions, reuseCompleted, after = readBoundary()) {
  if (!current() || requestedKey !== key) return
  metadata.refreshCalls++; activeRefreshes++
  const requiredRevision = requiredRevisions?.[entity] ?? 0
  post({ type: 'refresh', requiredRevision, reuseCompleted: reuseCompleted === true }); emitState()
  try {
    const authorized = () => ownerId && namespace && readCacheShareNamespace(cache, ownerId) === namespace
    const heldAtStart = { ...cache.get(key)?.data?.live?.revisions }
    const accepts = data => {
      const accepted = coversLiveRevisions(data, requiredRevisions)
        && coversLiveRevisions(data, heldAtStart)
        && coversLiveRevisions(data, cache.get(key)?.data?.live?.revisions)
      if (!accepted) metadata.rejectedOlderResults++
      post({ type: 'acceptance', requiredRevision, localRevision: revision(cache.get(key)?.data), resultRevision: revision(data), accepted })
      return accepted
    }
    const read = () => readFresh(cache, key, after, () => readSnapshot(requiredRevision, reuseCompleted), accepts, current)
    if (!authorized()) return await read()
    const previous = cache.get(key)?.data
    return await readFresh(cache, key, after, () => tabs.run(key, read, data => {
      if (!current() || !authorized()) return
      if (cache.get(key)?.data === previous) {
        metadata.adopted++; post({ type: 'adopt', requiredRevision, resultRevision: revision(data) })
        return storeSnapshot(data)
      }
      return read()
    }, accepts, reuseCompleted), accepts, current)
  } catch { fatal() }
  finally { activeRefreshes--; firstReadSettled = true; emitState(); tryReady() }
}

channel = new LiveChannel({
  ticket: signal => request('ticket', {}, signal),
  socket(ticket) {
    if (++socketCount !== 1) { fatal(); fail('live_reconnect_disallowed') }
    metadata.socketCount = socketCount
    const socket = new WebSocket(ticket.url, ticket.protocol)
    socket.addEventListener('message', message => {
      if (closing || typeof message.data !== 'string' || message.data.length > 2_048 || message.data === 'pong') return
      let parsed
      try { parsed = JSON.parse(message.data) } catch { return }
      const readiness = liveReadiness(parsed)
      if (readiness) {
        if (!readiness.kinds.includes('bot_chat') || !readiness.revisions.includes('bot_chat')) { fatal(); return }
        transportReady = true; post({ type: 'transport-ready' }); tryReady(); return
      }
      const event = liveInvalidation(parsed, true)
      if (event?.kind !== 'bot_chat' || event.id.toLowerCase() !== botId.toLowerCase()) return
      metadata.pushes++; if (event.rev) metadata.versionedPushes++
      post({ type: 'push', revision: event.rev ?? null }); emitState()
    })
    socket.addEventListener('error', fatal)
    socket.addEventListener('close', () => { if (!closing) fatal() })
    return socket
  },
  visible: () => !closing,
  watchVisibility: () => () => {},
  now: Date.now,
  monotonicNow: () => performance.now(),
  later(callback, milliseconds) {
    const timer = setTimeout(() => { timers.delete(timer); callback() }, milliseconds)
    timers.add(timer); return timer
  },
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
subscription = channel.subscribe('bot_chat', botId, [key], refresh, { minIntervalMs: 2_000,
  revisions: { [key]: revision(initialChat) } })
