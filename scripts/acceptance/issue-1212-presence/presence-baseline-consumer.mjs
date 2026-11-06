import { Worker } from 'node:worker_threads'
import { normalDeviceRead, validateLiveTicket } from './presence-consumer.mjs'
const fail = code => { throw Object.assign(new Error(code), { code }) }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const milliseconds = () => Math.round(performance.now())

export function validateBaselineRead(value, fixture, ownerId) {
  const own = value?.devices?.find(row => row.id === fixture.deviceId)
  if (value?.live?.ownerId !== ownerId || !UUID.test(value?.live?.workspaceId ?? '') || !own
    || own.name !== fixture.marker || own.enabled !== false || !Array.isArray(own.harnesses)
    || own.harnesses.length || typeof own.online !== 'boolean') fail('presence_baseline_read_invalid')
  return value
}

export async function openBaselineConsumers(session, initialRead, { fixture, source, expectedSha,
  gatewayOrigin, WorkerClass = Worker, checkpoint = () => {}, readyTimeoutMs = 25_000 } = {}) {
  const ownerId = session.identity.userId, home = initialRead.live.workspaceId, tabCount = 3
  validateBaselineRead(initialRead, fixture, ownerId)
  const report = { schemaVersion: 1, case: 'old-device-client-three-native-workers', applicationSha: expectedSha,
    sourceCommit: source.sourceBase, sourceHashes: source.hashes, tabCount, network: [], tabs: [], phases: [],
    adaptation: { nativeWebSocket: true, independentHeaps: true, cookieInParentOnly: true, actualOldLiveChannels: true,
      oldHomeAndNullSubscriptions: true, tabShare: false, reactSWRRendered: false, installedDaemon: false }, closed: false }
  const workers = [], states = new Map(), active = new Map(), listeners = new Set()
  let phase = 'initial', fault = null, closing = false, closePromise
  const seen = () => { checkpoint(report); for (const listener of [...listeners]) listener() }
  const waitUntil = (predicate, timeoutMs, honorFault = true) => new Promise(resolve => {
    let done = false
    const finish = value => { if (done) return; done = true; clearTimeout(timer); listeners.delete(check); resolve(value) }
    const check = () => { if (predicate()) finish(true); else if (honorFault && fault) finish(false) }
    const timer = setTimeout(() => finish(false), timeoutMs)
    listeners.add(check); check()
  })
  const ready = () => states.size === tabCount && [...states.values()].every(row => row.ready && row.activeRefreshes === 0)
  const baselineReady = () => ready() && [...states.values()].every(row => row.fallbackActive && row.online === true && row.socketCount === 1)
  const proxy = async (worker, tabId, message) => {
    const id = tabId + ':' + message.id, controller = new AbortController()
    active.set(id, controller)
    const row = { tabId, method: message.method, phase, startedAtMs: milliseconds() }
    report.network.push(row); seen()
    try {
      if (report.network.length > 64) fail('presence_baseline_read_limit')
      let value
      if (message.method === 'ticket') {
        if (report.network.filter(item => item.method === 'ticket' && item.tabId === tabId).length !== 1) fail('presence_baseline_reconnect_outside_case')
        const response = await session.request('/api/live/ticket?workspace=' + home,
          { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) })
        if (!response.ok) fail('presence_baseline_ticket_failed')
        value = validateLiveTicket(await response.json(), ownerId, home, gatewayOrigin)
      } else if (message.method === 'devices') {
        value = validateBaselineRead(await normalDeviceRead(session, controller.signal), fixture, ownerId)
        if (value.live.workspaceId !== home) fail('presence_baseline_home_changed')
        row.online = value.devices.find(item => item.id === fixture.deviceId).online
        row.presenceFallback = value.presenceFallback === true
      } else fail('presence_baseline_method_invalid')
      row.status = 'completed'; worker.postMessage({ type: 'response', id: message.id, ok: true, value })
    } catch {
      row.status = 'failed'; if (!closing) fault ??= 'presence_baseline_proxy_failed'
      worker.postMessage({ type: 'response', id: message.id, ok: false })
    } finally { active.delete(id); row.finishedAtMs = milliseconds(); seen() }
  }
  const receive = (worker, tabId, message) => {
    if (!message || message.tabId !== tabId) { fault ??= 'presence_baseline_worker_scope_invalid'; seen(); return }
    if (message.type === 'request') {
      if (closing || !Number.isSafeInteger(message.id) || !['ticket', 'devices'].includes(message.method)) { fault ??= 'presence_baseline_method_invalid'; seen(); return }
      void proxy(worker, tabId, message); return
    }
    if (message.type === 'cancel') { active.get(tabId + ':' + message.id)?.abort(); return }
    if (message.type === 'fatal') { if (!closing) fault ??= 'presence_baseline_worker_failed'; seen(); return }
    if (message.type !== 'state' && message.type !== 'closed') return
    const value = { ...states.get(tabId), tabId, closed: message.type === 'closed',
      ...(message.type === 'state' ? { online: message.online, ready: message.ready === true, fallbackActive: message.fallbackActive === true } : {}) }
    for (const name of ['refreshCalls', 'networkReads', 'devicePushes', 'threadPushes', 'socketCount', 'nullTicketAttempts', 'activeRefreshes']) {
      if (!Number.isSafeInteger(message[name]) || message[name] < 0) { fault ??= 'presence_baseline_metadata_invalid'; seen(); return }
      value[name] = message[name]
    }
    states.set(tabId, value); report.tabs = [...states.values()]; seen()
  }
  const close = () => closePromise ??= (async () => {
    closing = true
    for (const worker of workers) worker.postMessage({ type: 'close' })
    await waitUntil(() => states.size === tabCount && [...states.values()].every(row => row.closed), 3_000, false)
    for (const controller of active.values()) controller.abort()
    await Promise.allSettled(workers.map(worker => worker.terminate()))
    report.closed = true; report.fault = fault; seen(); return report
  })()
  try {
    for (let tabId = 1; tabId <= tabCount; tabId++) {
      const worker = new WorkerClass(new URL('./presence-baseline-worker.mjs', import.meta.url), { workerData: {
        sourceDirectory: source.directory, tabId, ownerId, home, fixtureId: fixture.deviceId, initialRead,
      }, env: {} })
      workers.push(worker)
      worker.on('message', message => receive(worker, tabId, message))
      worker.on('error', () => { if (!closing) fault ??= 'presence_baseline_worker_failed'; seen() })
      worker.on('exit', code => { if (!closing && code) { fault ??= 'presence_baseline_worker_exited'; seen() } })
    }
    if (!await waitUntil(ready, readyTimeoutMs) || fault) fail('presence_baseline_ready_failed')
    return { report,
      async settle() { if (!await waitUntil(() => baselineReady() && active.size === 0, 10_000) || fault) fail('presence_baseline_not_gateway_fallback') },
      async quiet(durationMs) {
        if (!baselineReady() || active.size || fault) fail('presence_baseline_not_gateway_fallback')
        phase = 'healthy-idle'
        const start = milliseconds(), index = report.network.length
        await new Promise(resolve => setTimeout(resolve, durationMs))
        const elapsedMs = milliseconds() - start
        phase = 'after-idle'
        if (!await waitUntil(() => active.size === 0 && ready(), 20_000) || fault) fail('presence_baseline_read_failed')
        const measured = report.network.slice(index).filter(row => row.phase === 'healthy-idle' && row.method === 'devices')
        const byTab = Object.fromEntries([...states.keys()].map(id => [id, measured.filter(row => row.tabId === id).length]))
        const value = { name: 'healthy-idle', elapsedMs, actualReads: measured.length, byTab,
          allOldFallbacksActive: baselineReady(), allReadsSucceeded: measured.every(row => row.status === 'completed'), adopted: 0 }
        report.phases.push(value); seen()
        if (!value.allOldFallbacksActive || !value.allReadsSucceeded || Object.values(byTab).some(count => count < 1)) fail('presence_baseline_window_invalid')
        return value
      }, close }
  } catch (error) { await close(); throw error }
}
