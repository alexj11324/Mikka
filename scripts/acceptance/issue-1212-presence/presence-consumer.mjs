// Real native WebSockets and BroadcastChannels; authenticated HTTP stays here.
import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { decode } from '../issue-1504-1506/production-session.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const hash = value => createHash('sha256').update(value).digest('hex')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const milliseconds = () => Math.round(performance.now())

export async function normalDeviceRead(session, signal) {
  const response = await session.request('/api/rpc', { body: { version: 1, action: 'agents.pollDevices', args: [] },
    headers: { 'x-mikka-rpc': '1' }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) })
  const envelope = await response.json().catch(() => null), value = decode(envelope?.result)
  if (!response.ok || envelope?.ok !== true || value?.error || !Array.isArray(value?.devices)) fail('presence_read_failed')
  return value
}

export function validatePresenceRead(value, fixture, ownerId) {
  const own = value?.devices?.find(row => row.id === fixture.deviceId)
  if (value?.live?.ownerId !== ownerId || !UUID.test(value?.live?.workspaceId ?? '') || !own
    || own.name !== fixture.marker || own.enabled !== false || !Array.isArray(own.harnesses) || own.harnesses.length
    || typeof own.online !== 'boolean' || typeof value.live.presence?.token !== 'string'
    || !Number.isSafeInteger(value.live.presence.expiresAt) || value.live.presence.expiresAt <= Date.now()) fail('presence_read_scope_invalid')
  return value
}

export function validateLiveTicket(ticket, ownerId, home, gatewayOrigin) {
  let url
  try { url = new URL(ticket?.url) } catch { fail('presence_ticket_invalid') }
  const channel = hash(JSON.stringify([ownerId, home]))
  if (url.protocol !== 'wss:' || url.origin !== gatewayOrigin || url.username || url.password || url.search || url.hash
    || url.pathname !== `/v1/live/${channel}/socket` || typeof ticket.protocol !== 'string' || !ticket.protocol
    || !Number.isSafeInteger(ticket.expiresAt) || ticket.expiresAt <= Date.now()) fail('presence_ticket_invalid')
  return ticket
}

export async function openPresenceConsumers(session, initialRead, { fixture, source, expectedSha,
  gatewayOrigin, WorkerClass = Worker, checkpoint = () => {}, readyTimeoutMs = 25_000 } = {}) {
  validatePresenceRead(initialRead, fixture, session.identity.userId)
  const ownerId = session.identity.userId, home = initialRead.live.workspaceId, tabCount = 3
  const expectedNamespace = JSON.stringify([1, ownerId, home, expectedSha, 'admin'])
  const report = { schemaVersion: 1, case: 'presence-core-three-native-workers', applicationSha: expectedSha,
    sourceBase: source.sourceBase, sourceHashes: source.hashes, tabCount, namespaceRef: hash(expectedNamespace).slice(0, 12),
    events: [], network: [], tabs: [], phases: [], adaptation: { nativeWebSocket: true,
      nativeBroadcastChannel: true, independentHeaps: true, cookieInParentOnly: true,
      actualCoreAlgorithms: true, reactSWRRendered: false, installedDaemon: false }, closed: false }
  const workers = [], states = new Map(), active = new Map(), listeners = new Set()
  let phase = 'initial', fault = null, closing = false, closePromise
  const seen = () => { checkpoint(report); for (const listener of [...listeners]) listener() }
  const record = value => {
    if (report.events.length >= 1_000) { fault ??= 'presence_event_limit'; seen(); return }
    report.events.push({ ...value, phase, atMs: milliseconds() }); seen()
  }
  const waitUntil = (predicate, timeoutMs, honorFault = true) => new Promise(resolve => {
    let done = false
    const finish = value => { if (done) return; done = true; clearTimeout(timer); listeners.delete(check); resolve(value) }
    const check = () => { if (predicate()) finish(true); else if (honorFault && fault) finish(false) }
    const timer = setTimeout(() => finish(false), timeoutMs)
    listeners.add(check); check()
  })
  const allReady = () => states.size === tabCount && [...states.values()].every(row => row.ready && row.covered && row.activeRefreshes === 0)
  const proxy = async (worker, tabId, message) => {
    const id = tabId + ':' + message.id, controller = new AbortController()
    active.set(id, controller)
    const row = { tabId, method: message.method, phase, startedAtMs: milliseconds() }
    report.network.push(row); seen()
    try {
      if (report.network.length > 64) fail('presence_read_limit')
      let value
      if (message.method === 'ticket') {
        if (report.network.filter(item => item.tabId === tabId && item.method === 'ticket').length !== 1) fail('presence_ticket_renew_outside_case')
        const response = await session.request('/api/live/ticket?workspace=' + home,
          { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) })
        if (!response.ok) fail('presence_ticket_failed')
        value = validateLiveTicket(await response.json(), ownerId, home, gatewayOrigin)
      } else if (message.method === 'devices') {
        value = validatePresenceRead(await normalDeviceRead(session, controller.signal), fixture, ownerId)
        if (value.live.workspaceId !== home) fail('presence_home_changed')
        row.online = value.devices.find(item => item.id === fixture.deviceId).online
      } else fail('presence_proxy_method_invalid')
      row.status = 'completed'; worker.postMessage({ type: 'response', id: message.id, ok: true, value })
    } catch {
      row.status = 'failed'; if (!closing) fault ??= 'presence_proxy_failed'
      worker.postMessage({ type: 'response', id: message.id, ok: false })
    } finally { active.delete(id); row.finishedAtMs = milliseconds(); seen() }
  }
  const receive = (worker, tabId, message) => {
    if (!message || message.tabId !== tabId) { fault ??= 'presence_worker_scope_invalid'; seen(); return }
    if (message.type === 'request') {
      if (closing || !Number.isSafeInteger(message.id) || !['ticket', 'devices'].includes(message.method)) { fault ??= 'presence_proxy_method_invalid'; seen(); return }
      void proxy(worker, tabId, message); return
    }
    if (message.type === 'cancel') { active.get(tabId + ':' + message.id)?.abort(); return }
    if (message.type === 'state' || message.type === 'closed') {
      if (message.type === 'state' && message.namespace !== expectedNamespace) { fault ??= 'presence_namespace_invalid'; seen(); return }
      const value = { ...states.get(tabId), tabId, closed: message.type === 'closed',
        ...(message.type === 'state' ? { online: message.online, ready: message.ready === true, covered: message.covered === true } : {}) }
      for (const name of ['refreshCalls', 'networkReads', 'adopted', 'rejectedOlderResults', 'devicePushes', 'threadPushes', 'acknowledgements', 'watches', 'unwatches', 'socketCount', 'activeRefreshes']) {
        if (!Number.isSafeInteger(message[name]) || message[name] < 0) { fault ??= 'presence_metadata_invalid'; seen(); return }
        value[name] = message[name]
      }
      states.set(tabId, value); report.tabs = [...states.values()]; seen(); return
    }
    if (message.type === 'fatal' || message.type === 'unavailable') { if (!closing) fault ??= 'presence_worker_failed'; seen(); return }
    if (['push', 'ack', 'refresh', 'adopt'].includes(message.type)) record({ type: message.type, tabId,
      ...(message.type === 'push' && ['device_list', 'thread_list'].includes(message.kind) ? { kind: message.kind } : {}) })
  }
  const close = () => closePromise ??= (async () => {
    closing = true
    for (const worker of workers) worker.postMessage({ type: 'close' })
    await waitUntil(() => states.size === tabCount && [...states.values()].every(row => row.closed), 3_000, false)
    for (const controller of active.values()) controller.abort()
    await Promise.allSettled(workers.map(worker => worker.terminate()))
    report.closed = true; report.fault = fault; seen()
    return report
  })()
  try {
    for (let tabId = 1; tabId <= tabCount; tabId++) {
      const worker = new WorkerClass(new URL('./presence-worker.mjs', import.meta.url), {
        workerData: { sourceDirectory: source.directory, tabId, ownerId, home, build: expectedSha,
          fixtureId: fixture.deviceId, initialRead }, env: {} })
      workers.push(worker)
      worker.on('message', message => receive(worker, tabId, message))
      worker.on('error', () => { if (!closing) fault ??= 'presence_worker_failed'; seen() })
      worker.on('exit', code => { if (!closing && code) { fault ??= 'presence_worker_exited'; seen() } })
    }
    if (!await waitUntil(allReady, readyTimeoutMs) || fault) fail('presence_ready_failed')
    const begin = name => {
      if (fault || !allReady() || active.size) fail('presence_phase_not_ready')
      phase = name
      const baseline = Object.fromEntries([...states].map(([id, value]) => [id, { ...value }]))
      return { name, startedAtMs: milliseconds(), networkIndex: report.network.length, baseline }
    }
    const finish = (marker, extra = {}) => {
      const rows = report.network.slice(marker.networkIndex).filter(row => row.method === 'devices')
      const result = { name: marker.name, elapsedMs: milliseconds() - marker.startedAtMs, actualReads: rows.length,
        allReadsSucceeded: rows.every(row => row.status === 'completed'),
        adopted: [...states].reduce((sum, [id, value]) => sum + value.adopted - marker.baseline[id].adopted, 0), ...extra }
      report.phases.push(result); seen(); return result
    }
    return { report, begin,
      async waitState(marker, online, timeoutMs) {
        const ok = await waitUntil(() => allReady() && active.size === 0 && [...states].every(([id, row]) => row.online === online
          && row.devicePushes > marker.baseline[id].devicePushes && row.threadPushes > marker.baseline[id].threadPushes), timeoutMs)
        const result = finish(marker, { online, allTabsReceivedBothKeys: ok && !fault })
        // The existing unversioned two-second throttle can spread a burst past
        // a completed shared read. Record that residual duplicate honestly;
        // it must not exceed the three independent old consumers' reads.
        if (!ok || fault || result.actualReads < 1 || result.actualReads > tabCount || !result.allReadsSucceeded) fail('presence_state_coverage_failed')
        return result
      },
      async quiet(millisecondsToObserve) {
        const marker = begin('healthy-idle')
        await new Promise(resolve => setTimeout(resolve, millisecondsToObserve))
        const result = finish(marker, { allTabsCovered: allReady() })
        if (fault || !allReady() || result.actualReads !== 0 || report.network.slice(marker.networkIndex).length !== 0) fail('presence_idle_read_detected')
        return result
      },
      async settle() { if (!await waitUntil(() => allReady() && active.size === 0, 10_000) || fault) fail('presence_settle_failed') },
      close,
    }
  } catch (error) { await close(); throw error }
}
