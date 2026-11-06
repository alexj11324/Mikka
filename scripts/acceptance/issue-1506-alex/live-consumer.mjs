// Real gateway sockets + unmodified reviewed core consumers. No timer polling.
// This observer is injected into the existing cache-turn runner; it sends no messages.
import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { ALEX_OWNER_ID } from '../issue-1506-readonly/alex-session.mjs'
import { readJson, rpc, validateChat } from '../issue-1504-1506/coordinator-baseline.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 12)
const milliseconds = () => Math.round(performance.now() * 10) / 10
const fail = code => { throw new Error(code) }

export function validateLiveScope(session, initialChat, fixture, expectedSha) {
  if (session.identity?.userId !== ALEX_OWNER_ID || session.version?.build !== expectedSha ||
    initialChat?.botId !== fixture.botId || initialChat.live?.ownerId !== ALEX_OWNER_ID ||
    !UUID.test(initialChat.live?.workspaceId ?? '') || !UUID.test(fixture.workspace?.id ?? '') ||
    fixture.workspace.id === '4ae2a643-b09e-43eb-816c-1e5557bef170' || fixture.workspace.kind !== 'team') fail('live_consumer_scope_invalid')
  return { botId: fixture.botId, workspaceId: fixture.workspace.id, transportScope: initialChat.live.workspaceId,
    ownerId: ALEX_OWNER_ID, build: expectedSha }
}

function validateTicket(ticket) {
  let url
  try { url = new URL(ticket?.url) } catch { fail('live_ticket_invalid') }
  if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash ||
    !/^\/v1\/live\/[a-f0-9]{64}\/socket$/.test(url.pathname) || typeof ticket.protocol !== 'string' ||
    !ticket.protocol || !Number.isFinite(ticket.expiresAt) || ticket.expiresAt <= Date.now()) fail('live_ticket_invalid')
  return ticket
}

export function summarizeLiveEvidence(report) {
  const activeEvents = report.events.filter(event => event.stage === 'turns')
  const pushes = activeEvents.filter(event => event.type === 'push' && Number.isSafeInteger(event.revision))
  const requiredRefreshes = activeEvents.filter(event => event.type === 'refresh' && event.requiredRevision > 0)
  const reads = report.network.filter(row => row.stage === 'turns' && row.method === 'chat')
  const freshReads = reads.filter(row => row.requiredRevision > 0 && row.resultRevision >= row.requiredRevision &&
    pushes.some(push => push.revision >= row.requiredRevision && push.atMs <= row.startedAtMs))
  const adopted = activeEvents.filter(event => event.type === 'adopt' && event.requiredRevision > 0 && event.resultRevision >= event.requiredRevision)
  const staleRejected = activeEvents.filter(event => event.type === 'acceptance' && event.accepted === false &&
    event.resultRevision < Math.max(event.requiredRevision, event.localRevision))
  const highestRevision = Math.max(0, ...pushes.map(row => row.revision))
  const finalTabs = report.tabs.filter(tab => tab.closed)
  const allTabsCoverLatest = highestRevision > 0 && finalTabs.length === report.tabCount &&
    finalTabs.every(tab => tab.latestRevision >= highestRevision)
  return { uniqueNewRevisions: new Set(pushes.map(row => row.revision)).size, highestRevision,
    revisionTriggeredRefreshes: requiredRefreshes.length, realChatReadsDuringTurns: reads.length,
    realFreshReadsAfterPush: freshReads.length, acceptedSharedResults: adopted.length,
    rejectedOlderSharedResults: staleRejected.length, allTabsCoverLatest,
    eventToReadObserved: freshReads.length > 0,
    sharingObserved: adopted.length > 0 && requiredRefreshes.length > freshReads.length,
    staleResultProtection: staleRejected.length > 0 ? 'observed' : 'not_covered',
    browserReactRender: 'not_run' }
}

export async function openLiveConsumers(session, initialChat, { fixture, source, expectedSha,
  tabCount = 3, delayOneReturnedResult = false, readyTimeoutMs = 20_000, coverageTimeoutMs = 12_000,
  WorkerClass = Worker, checkpoint = () => {} } = {}) {
  if (![2, 3].includes(tabCount)) fail('live_tab_count_invalid')
  const scope = validateLiveScope(session, initialChat, fixture, expectedSha)
  const entity = 'bot_chat:' + scope.botId.toLowerCase()
  const report = { schemaVersion: 1, issue: 1506, case: 'real-live-core-consumers', status: 'running',
    sourceCommit: source.sourceCommit, sourceHashes: source.hashes, applicationSha: expectedSha,
    fixture: { botId: scope.botId, workspaceRef: hash(scope.workspaceId), ownerRef: hash(scope.ownerId), transportRef: hash(scope.transportScope) },
    tabCount, sharedNamespaceRef: null, events: [], network: [], tabs: [],
    adaptation: { independentWorkerHeaps: true, nativeWebSocket: true, nativeBroadcastChannel: true,
      sameAuthorizedNamespace: true, cookieInParentOnly: true, fullNormalRpcSnapshots: true,
      delayedOneAlreadyReturnedResponse: delayOneReturnedResult, delay: null, reactSWRRendered: false },
    modelMessagesSentByObserver: 0, pollingTimersAdded: 0, startedAt: new Date().toISOString() }
  const summary = { ready: false, revisionCapable: false, matchingPushes: 0, versionedPushes: 0,
    newerPushes: 0, baselineRevision: initialChat.live.revisions?.[entity] ?? null,
    maxRevision: null, firstPushMs: null, unexpectedDisconnect: false, closed: false }
  const workers = [], states = new Map(), active = new Map(), pushed = new Set(), listeners = new Set()
  let stage = 'initial', began = null, fault = null, closePromise = null, namespace = null, gate = null, gateUsed = false
  const seen = () => { checkpoint(report); for (const listener of [...listeners]) listener() }
  const record = value => {
    if (report.events.length >= 500) { fault ??= 'live_event_limit'; seen(); return }
    report.events.push({ ...value, stage, atMs: milliseconds() }); seen()
  }
  const waitUntil = (predicate, timeoutMs, honorFault = true) => new Promise(resolve => {
    let done = false
    const finish = value => { if (done) return; done = true; clearTimeout(timer); listeners.delete(check); resolve(value) }
    const check = () => { if (predicate()) finish(true); else if (honorFault && fault) finish(false) }
    const timer = setTimeout(() => finish(false), timeoutMs)
    listeners.add(check); check()
  })
  const releaseGate = reason => {
    if (!gate) return
    const held = gate; gate = null; clearTimeout(held.timer)
    report.adaptation.delay = { resultRevision: held.revision, releaseReason: reason,
      returnedAtMs: held.returnedAt, deliveredAtMs: milliseconds(), newRevision: held.nextRevision ?? null }
    held.resolve(); seen()
  }
  const deferReturned = async revision => {
    if (!delayOneReturnedResult || gateUsed || stage !== 'turns') return
    gateUsed = true
    await new Promise(resolve => {
      gate = { revision, resolve, returnedAt: milliseconds(), timer: setTimeout(() => releaseGate('bounded_timeout_no_new_revision'), 8_000) }
      // A real newer push may have arrived while the HTTP response was being read.
      if ((summary.maxRevision ?? 0) > revision) { gate.nextRevision = summary.maxRevision; releaseGate('new_real_revision_already_observed') }
    })
  }
  const proxy = async (worker, tabId, message) => {
    const requestKey = tabId + ':' + message.id
    const controller = new AbortController()
    active.set(requestKey, controller)
    const row = { tabId, requestId: message.id, method: message.method, stage,
      requiredRevision: message.method === 'chat' ? message.requiredRevision : null, startedAtMs: milliseconds() }
    report.network.push(row); seen()
    try {
      let value
      if (message.method === 'ticket') {
        if (report.network.filter(item => item.tabId === tabId && item.method === 'ticket').length !== 1) fail('live_reconnect_disallowed')
        value = validateTicket(await readJson(session, '/api/live/ticket?workspace=' + scope.transportScope, { signal: controller.signal, timeoutMs: 15_000 }))
      } else if (message.method === 'chat') {
        if (!Number.isSafeInteger(message.requiredRevision) || message.requiredRevision < 0 ||
          report.network.filter(item => item.method === 'chat').length > 24) fail('live_read_limit')
        const chat = validateChat(await rpc(session, 'coordinator.syncCoordinatorChat', [scope.botId], { signal: controller.signal }))
        if (chat.botId !== scope.botId || chat.live?.ownerId !== scope.ownerId || chat.live?.workspaceId !== scope.transportScope) fail('live_snapshot_scope_invalid')
        row.resultRevision = Number.isSafeInteger(chat.live?.revisions?.[entity]) ? chat.live.revisions[entity] : 0
        row.returnedAtMs = milliseconds(); row.working = chat.working; row.activeStream = Boolean(chat.streamRunId)
        await deferReturned(row.resultRevision)
        value = chat
      } else fail('live_method_invalid')
      row.status = 'completed'; row.deliveredAtMs = milliseconds()
      worker.postMessage({ type: 'response', id: message.id, ok: true, value })
    } catch {
      row.status = 'failed'; fault ??= 'live_proxy_failed'
      worker.postMessage({ type: 'response', id: message.id, ok: false })
    } finally { active.delete(requestKey); row.finishedAtMs = milliseconds(); seen() }
  }
  const receive = (worker, tabId, message) => {
    if (!message || message.tabId !== tabId) { fault ??= 'live_worker_scope_invalid'; seen(); return }
    if (message.type === 'request') {
      if (!Number.isSafeInteger(message.id) || message.id < 1 || !['ticket', 'chat'].includes(message.method)) { fault ??= 'live_method_invalid'; seen(); return }
      void proxy(worker, tabId, message); return
    }
    if (message.type === 'cancel') { active.get(tabId + ':' + message.id)?.abort(); return }
    if (message.type === 'ready') {
      const expected = JSON.stringify([1, scope.ownerId, scope.workspaceId, expectedSha, 'admin'])
      if (message.namespace !== expected || namespace !== null && namespace !== message.namespace) fault ??= 'live_namespace_mismatch'
      namespace = message.namespace; report.sharedNamespaceRef = hash(namespace)
      states.set(tabId, { ...states.get(tabId), ready: true }); seen(); return
    }
    if (message.type === 'state' || message.type === 'closed') {
      const value = { tabId, ready: states.get(tabId)?.ready === true, closed: message.type === 'closed' || states.get(tabId)?.closed === true,
        latestRevision: message.latestRevision, activeRefreshes: message.activeRefreshes,
        refreshCalls: message.refreshCalls, networkReads: message.networkReads,
        adopted: message.adopted, rejectedOlderResults: message.rejectedOlderResults, socketCount: message.socketCount }
      if (Object.values(value).some(item => typeof item === 'number' && (!Number.isSafeInteger(item) || item < 0))) fault ??= 'live_metadata_invalid'
      states.set(tabId, value); report.tabs = [...states.values()]; seen(); return
    }
    if (message.type === 'fatal') { fault ??= 'live_worker_failed'; summary.unexpectedDisconnect = true; seen(); return }
    if (message.type === 'push') {
      if (!Number.isSafeInteger(message.revision) || message.revision <= 0) { fault ??= 'live_revision_required'; seen(); return }
      if (stage === 'turns' && !pushed.has(message.revision)) {
        pushed.add(message.revision); summary.matchingPushes++; summary.versionedPushes++
        summary.maxRevision = Math.max(summary.maxRevision ?? 0, message.revision)
        if (message.revision > (summary.baselineRevision ?? 0)) summary.newerPushes++
        summary.firstPushMs ??= Math.round((performance.now() - began) * 10) / 10
      }
      if (gate && message.revision > gate.revision) { gate.nextRevision = message.revision; releaseGate('new_real_revision_observed') }
      record({ type: 'push', tabId, revision: message.revision }); return
    }
    if (['refresh', 'acceptance', 'adopt'].includes(message.type)) {
      const recordValue = { type: message.type, tabId }
      for (const key of ['requiredRevision', 'localRevision', 'resultRevision']) if (message[key] !== undefined) {
        if (!Number.isSafeInteger(message[key]) || message[key] < 0) { fault ??= 'live_metadata_invalid'; seen(); return }
        recordValue[key] = message[key]
      }
      if (message.type === 'refresh') recordValue.reuseCompleted = message.reuseCompleted === true
      if (message.type === 'acceptance') recordValue.accepted = message.accepted === true
      record(recordValue)
    }
  }
  const shutdown = async () => {
    releaseGate('observer_closed')
    for (const controller of active.values()) controller.abort()
    for (const { worker } of workers) worker.postMessage({ type: 'close' })
    await waitUntil(() => states.size === tabCount && [...states.values()].every(row => row.closed), 3_000, false)
    // Terminate only this harness's own worker threads, so retained core timers
    // cannot keep an Actions process alive after the sockets/channels close.
    await Promise.allSettled(workers.map(async ({ worker }) => worker.terminate()))
    summary.closed = true; report.finishedAt = new Date().toISOString(); report.error = fault
    report.evidence = summarizeLiveEvidence(report)
    report.status = fault ? 'failed' : report.evidence.eventToReadObserved && report.evidence.allTabsCoverLatest && report.evidence.sharingObserved
      ? 'live_evidence_captured' : 'incomplete_coverage'
    checkpoint(report)
    return !fault && report.status === 'live_evidence_captured'
  }
  try {
    for (let index = 0; index < tabCount; index++) {
      const tabId = index + 1
      const worker = new WorkerClass(new URL('./live-worker.mjs', import.meta.url), { workerData: {
        sourceDirectory: source.directory, tabId, ...scope, initialChat,
      }, env: {} }) // No runner credentials or ambient secrets enter worker environments.
      workers.push({ worker, tabId })
      worker.on('message', message => receive(worker, tabId, message))
      worker.on('error', () => { fault ??= 'live_worker_failed'; seen() })
      worker.on('exit', code => { if (code !== 0 && !closePromise) { fault ??= 'live_worker_exited'; seen() } })
    }
    if (!await waitUntil(() => states.size === tabCount && [...states.values()].every(row => row.ready), readyTimeoutMs)) fail('live_consumer_ready_failed')
    if (fault) fail(fault)
    summary.ready = true; summary.revisionCapable = true
    return { summary, report,
      begin(started) { began = started; stage = 'turns' },
      close() {
        closePromise ??= (async () => {
          if (!fault && !await waitUntil(() => {
            const revision = summary.maxRevision ?? 0
            return revision > 0 && active.size === 0 && states.size === tabCount &&
              [...states.values()].every(row => row.latestRevision >= revision && row.activeRefreshes === 0)
          }, coverageTimeoutMs)) fault ??= 'live_final_coverage_missing'
          return shutdown()
        })()
        return closePromise
      },
    }
  } catch {
    fault ??= 'live_consumer_ready_failed'; closePromise ??= shutdown(); await closePromise
    fail('live_consumer_ready_failed')
  }
}
