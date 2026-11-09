// Temporary two-login diagnostic collector. Never controls readiness, reads, budgets or retries.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { READ_DIAGNOSTIC_SCHEMA } from '../../../lib/swr/read-diagnostics.ts'

const BOUNDARIES = {
        budgetPass: false, extraReadBoundaryCalls: 0, extraApplicationRequests: 0, originalCheckpointsChanged: false,
        coverage: 'webLogin/nativeLogin pages only; capture spans attachment through ordinary context close and can include tail; budgets use only the unchanged two windows; no cold FIRST capture; initial Native document may precede attachment',
        identity: 'per-document UUID and timeOrigin; CDP loader IDs are separate local identities, not a guessed cross-layer join',
        delivery: 'asynchronous test binding; missing delivery, other schema values and overflow remain incomplete; failure/pending counters sum observations and can repeat at snapshot/seal',
        clocks: 'product monotonicMs is relative to its actual document timeOrigin; wallMs and CDP monotonic clocks are separate',
        cost: 'retained rows/bytes are bounded; per-event CPU/IPC delivery is not capped and occurs inside original windows; no production performance claim',
        unknownAssociation: 'no user, workspace, raw SWR key, URL query, headers, body or server invocation ID; ambiguous action/time joins remain unknown',
      }
const LIMITS = { rows: 2048, bytes: 524288, documents: 16, networkIds: 1024 }
const COUNT_KEYS = ['droppedRows', 'droppedBytes', 'invalidPackets', 'missingDocuments', 'duplicateSequences', 'sequenceGaps', 'sinkFailures', 'pendingAtSnapshot', 'keyOmissions', 'scopeOmissions', 'entityOmissions', 'referenceOmissions', 'actionOmissions', 'schemaOther', 'networkIdOmissions', 'documentOmissions', 'unsealedDocuments', 'lateDocuments']
const BINDING = '__mikkaAcceptanceReadDiagnostic'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])
const FAMILIES = new Set(['/api/rpc', '/api/desktop/rpc', '/api/workspace', '/api/workspace/switcher',
  '/api/conversations', '/api/conversations/:id', '/api/conversations/:id/read',
  '/api/approved-writes', '/api/pending-actions', '/api/live/ticket', 'other-api', 'document', 'other'])
const EVENTS = new Set(READ_DIAGNOSTIC_SCHEMA.events)
const ACTIONS = new Set([...READ_DIAGNOSTIC_SCHEMA.actions, 'other'])
const KINDS = new Set([...READ_DIAGNOSTIC_SCHEMA.kinds, 'other'])
const KEYS = new Set([...READ_DIAGNOSTIC_SCHEMA.families, 'other'])
const NUMERIC = new Set(['cacheId', 'readId', 'channelId', 'requestId', 'itemId', 'keyId', 'scopeId', 'entityId',
  'after', 'began', 'pending', 'sent', 'generation', 'count', 'status', 'revision', 'omittedReferences', 'omittedActions'])
const FLAGS = new Set(['accepted', 'received', 'superseded', 'unconditional', 'reuse', 'proof',
  'keyOmitted', 'scopeOmitted', 'scopeKnown', 'entityOmitted'])
const DETAIL_KEYS = new Set(['version', 'producer', 'event', 'monotonicMs', 'wallMs', ...NUMERIC, ...FLAGS,
  'keyFamily', 'observedEvent', 'reason', 'state', 'outcome', 'kind', 'action', 'actions'])
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const integer = value => Number.isSafeInteger(value) && value >= 0
const exactKeys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => allowed.has(key))

export function diagnosticPathFamily(value, type) {
  let path
  try { path = new URL(value).pathname.replace(/^\/mikka(?=\/)/, '') } catch { return 'other' }
  if (FAMILIES.has(path)) return path
  if (/^\/api\/conversations\/[^/]+\/read$/.test(path)) return '/api/conversations/:id/read'
  if (/^\/api\/conversations\/[^/]+$/.test(path)) return '/api/conversations/:id'
  if (path.startsWith('/api/') || path.startsWith('/v1/')) return 'other-api'
  return type === 'Document' ? 'document' : 'other'
}
export function validDiagnosticDetail(value) {
  if (!exactKeys(value, DETAIL_KEYS) || value.version !== 1 || typeof value.producer !== 'string' || !UUID.test(value.producer)
    || !EVENTS.has(value.event) || !finite(value.monotonicMs) || !finite(value.wallMs)) return false
  for (const [key, item] of Object.entries(value)) {
    if (NUMERIC.has(key) && !integer(item)) return false
    if (FLAGS.has(key) && typeof item !== 'boolean') return false
    if (['observedEvent', 'reason', 'state', 'outcome'].includes(key) && !EVENTS.has(item)) return false
  }
  if (value.keyFamily !== undefined && !KEYS.has(value.keyFamily)) return false
  if (value.kind !== undefined && !KINDS.has(value.kind)) return false
  if (value.action !== undefined && !ACTIONS.has(value.action)) return false
  return value.actions === undefined || Array.isArray(value.actions) && value.actions.length <= 16 && value.actions.every(action => ACTIONS.has(action))
}

// This function is serialized by Playwright into each actual document.
function installDocumentSink({ binding, late }) {
  if (globalThis !== globalThis.top || Object.hasOwn(globalThis, '__mikkaReadDiagnosticState')) return
  const state = { documentId: crypto.randomUUID(), timeOrigin: performance.timeOrigin,
    initializedWallMs: Date.now(), initializedMonotonicMs: performance.now(), late,
    sequence: 0, failures: 0, pending: 0, attempted: 0 }
  const deliver = packet => {
    state.attempted++; state.pending++
    try {
      const result = globalThis[binding](packet)
      Promise.resolve(result).then(() => { state.pending-- }, () => { state.pending--; state.failures++ })
    } catch { state.pending--; state.failures++ }
  }
  Object.defineProperty(globalThis, '__mikkaReadDiagnosticState', { value: state, configurable: false })
  Object.defineProperty(globalThis, '__mikkaReadDiagnostic', { configurable: false, value: detail => {
    deliver({ kind: 'product', documentId: state.documentId, sequence: ++state.sequence, detail })
  } })
  deliver({ kind: 'document', documentId: state.documentId, sequence: 0,
    timeOrigin: state.timeOrigin, initializedWallMs: state.initializedWallMs,
    initializedMonotonicMs: state.initializedMonotonicMs, late })
  addEventListener('pagehide', () => deliver({ kind: 'seal', documentId: state.documentId, sequence: state.sequence,
    failures: state.failures, pending: state.pending, attempted: state.attempted, timeOrigin: state.timeOrigin }), { once: true })
}

export function createReadDiagnostics({ revision }) {
  const rows = [], pages = [], documents = new Map(), contexts = new WeakSet(), attached = new WeakMap()
  const counts = { droppedRows: 0, droppedBytes: 0, invalidPackets: 0, missingDocuments: 0, duplicateSequences: 0,
    sequenceGaps: 0, sinkFailures: 0, pendingAtSnapshot: 0, keyOmissions: 0, scopeOmissions: 0, entityOmissions: 0,
    referenceOmissions: 0, actionOmissions: 0, schemaOther: 0, networkIdOmissions: 0, documentOmissions: 0, unsealedDocuments: 0, lateDocuments: 0 }
  let usedBytes = 0
  const append = row => {
    const size = Buffer.byteLength(JSON.stringify(row))
    if (rows.length >= LIMITS.rows || usedBytes + size > LIMITS.bytes) { counts.droppedRows++; counts.droppedBytes += size; return }
    usedBytes += size; rows.push(row)
  }
  const collect = (source, packet) => {
    const page = attached.get(source.page)
    if (!page || source.frame !== source.page.mainFrame()) { counts.invalidPackets++; return }
    if (!packet || typeof packet.documentId !== 'string' || !UUID.test(packet.documentId) || !integer(packet.sequence)) { counts.invalidPackets++; return }
    const key = page.id + ':' + packet.documentId
    if (packet.kind === 'document') {
      if (!exactKeys(packet, new Set(['kind', 'documentId', 'sequence', 'timeOrigin', 'initializedWallMs', 'initializedMonotonicMs', 'late']))
        || packet.sequence !== 0 || !finite(packet.timeOrigin) || !finite(packet.initializedWallMs)
        || !finite(packet.initializedMonotonicMs) || typeof packet.late !== 'boolean') { counts.invalidPackets++; return }
      if (documents.has(key)) { counts.duplicateSequences++; return }
      if (documents.size >= LIMITS.documents) { counts.documentOmissions++; return }
      const document = { pageId: page.id, client: page.client, ...packet, lastSequence: 0, sealed: false }
      documents.set(key, document)
      counts.lateDocuments += Number(packet.late)
      append({ ...packet, pageId: page.id, receivedWallMs: Date.now() })
      return
    }
    if (packet.kind === 'seal') {
      if (!exactKeys(packet, new Set(['kind', 'documentId', 'sequence', 'failures', 'pending', 'attempted', 'timeOrigin']))
        || ![packet.failures, packet.pending, packet.attempted].every(integer) || !finite(packet.timeOrigin)) { counts.invalidPackets++; return }
      const document = documents.get(key)
      if (!document || document.timeOrigin !== packet.timeOrigin) counts.missingDocuments++
      else {
        document.sealed = packet.sequence === document.lastSequence && packet.failures === 0 && packet.pending === 0
        if (packet.sequence > document.lastSequence) counts.sequenceGaps += packet.sequence - document.lastSequence
      }
      counts.sinkFailures += packet.failures; counts.pendingAtSnapshot += packet.pending
      append({ ...packet, pageId: page.id, receivedWallMs: Date.now() })
      return
    }
    if (packet.kind !== 'product' || !exactKeys(packet, new Set(['kind', 'documentId', 'sequence', 'detail']))
      || !validDiagnosticDetail(packet.detail)) { counts.invalidPackets++; return }
    const document = documents.get(key)
    if (!document) counts.missingDocuments++
    else {
      if (packet.sequence > document.lastSequence) document.sealed = false
      if (packet.sequence <= document.lastSequence) counts.duplicateSequences++
      else if (packet.sequence !== document.lastSequence + 1) counts.sequenceGaps += packet.sequence - document.lastSequence - 1
      document.lastSequence = Math.max(document.lastSequence, packet.sequence)
    }
    const d = packet.detail
    counts.keyOmissions += Number(d.keyOmitted === true)
    counts.scopeOmissions += Number(d.scopeOmitted === true)
    counts.entityOmissions += Number(d.entityOmitted === true)
    counts.referenceOmissions += d.omittedReferences ?? 0
    counts.actionOmissions += d.omittedActions ?? 0
    counts.schemaOther += Object.values(d).filter(value => value === 'other').length
      + (d.actions?.filter(value => value === 'other').length ?? 0)
    append({ ...packet, pageId: page.id, receivedWallMs: Date.now() })
  }
  async function attach(page, client, { late = false } = {}) {
    const record = { id: pages.length + 1, client, attachmentLate: late, setup: { binding: false, initScript: false, cdp: false },
      closed: false, snapshot: null }
    pages.push(record); attached.set(page, record)
    page.on('close', () => { record.closed = true })
    const context = page.context()
    try {
      if (!contexts.has(context)) {
        await context.exposeBinding(BINDING, collect)
        await context.addInitScript(installDocumentSink, { binding: BINDING, late: false })
        contexts.add(context)
      }
      record.setup.binding = true; record.setup.initScript = true
      await page.evaluate(installDocumentSink, { binding: BINDING, late })
    } catch { counts.invalidPackets++ }
    try {
      const cdp = await context.newCDPSession(page)
      const requests = new Map(), loaders = new Map()
      let nextRequest = 0, nextLoader = 0
      const id = (map, value, next) => {
        if (typeof value !== 'string' || !value) return 0
        if (!map.has(value)) {
          if (map.size >= LIMITS.networkIds) { counts.networkIdOmissions++; return 0 }
          map.set(value, next())
        }
        return map.get(value)
      }
      cdp.on('Network.requestWillBeSent', value => {
        const method = METHODS.has(value.request?.method) ? value.request.method : 'OTHER'
        const family = diagnosticPathFamily(value.request?.url, value.type)
        if (family === 'other') return // static assets are outside this diagnostic's declared scope.
        if (family === 'other-api' || method === 'OTHER') counts.schemaOther++
        append({ kind: 'network', phase: 'dispatch', pageId: record.id,
          requestId: id(requests, value.requestId, () => ++nextRequest), loaderId: id(loaders, value.loaderId, () => ++nextLoader),
          method, family, cdpMonotonicMs: finite(value.timestamp) ? value.timestamp * 1000 : null,
          wallMs: finite(value.wallTime) ? value.wallTime * 1000 : null, receivedWallMs: Date.now(), redirected: Boolean(value.redirectResponse) })
      })
      cdp.on('Network.responseReceived', value => {
        const requestId = requests.get(value.requestId)
        if (!requestId) return
        append({ kind: 'network', phase: 'headers', pageId: record.id, requestId,
          status: integer(value.response?.status) ? value.response.status : null,
          cdpMonotonicMs: finite(value.timestamp) ? value.timestamp * 1000 : null, receivedWallMs: Date.now() })
      })
      for (const [event, phase] of [['Network.loadingFinished', 'complete'], ['Network.loadingFailed', 'failed']]) cdp.on(event, value => {
        const requestId = requests.get(value.requestId)
        if (requestId) append({ kind: 'network', phase, pageId: record.id, requestId,
          cdpMonotonicMs: finite(value.timestamp) ? value.timestamp * 1000 : null, receivedWallMs: Date.now() })
      })
      cdp.on('Page.frameNavigated', value => {
        if (value.frame?.parentId) return
        append({ kind: 'navigation', phase: 'committed', pageId: record.id,
          loaderId: id(loaders, value.frame?.loaderId, () => ++nextLoader), receivedWallMs: Date.now() })
      })
      cdp.on('Page.domContentEventFired', value => append({ kind: 'navigation', phase: 'domcontentloaded', pageId: record.id,
        cdpMonotonicMs: finite(value.timestamp) ? value.timestamp * 1000 : null, receivedWallMs: Date.now() }))
      await cdp.send('Network.enable')
      await cdp.send('Page.enable')
      record.setup.cdp = true
    } catch { counts.invalidPackets++ }
  }
  async function snapshot(page) {
    const record = attached.get(page)
    if (!record) return
    try {
      const value = await page.evaluate(() => {
        const state = Object.getOwnPropertyDescriptor(globalThis, '__mikkaReadDiagnosticState')?.value
        return state ? { documentId: state.documentId, sequence: state.sequence, failures: state.failures,
          pending: state.pending, attempted: state.attempted, timeOrigin: state.timeOrigin } : null
      })
      if (!value || typeof value.documentId !== 'string' || !UUID.test(value.documentId) || ![value.sequence, value.failures, value.pending, value.attempted].every(integer)
        || !finite(value.timeOrigin)) { counts.missingDocuments++; return }
      record.snapshot = value
      const document = documents.get(record.id + ':' + value.documentId)
      if (document && document.timeOrigin === value.timeOrigin) document.sealed = value.sequence === document.lastSequence && value.failures === 0 && value.pending === 0
      counts.sinkFailures += value.failures
      counts.pendingAtSnapshot += value.pending
    } catch { counts.missingDocuments++ }
  }
  async function write(path, windows) {
    counts.unsealedDocuments = [...documents.values()].filter(document => !document.sealed).length
    const report = { version: 1, revision, purpose: 'causal-diagnostic-only', limits: LIMITS,
      windows: Object.fromEntries(['webLogin', 'nativeLogin'].map(name => [name, {
        startedAt: windows?.[name]?.total?.startedAt ?? null, finishedAt: windows?.[name]?.total?.finishedAt ?? null,
      }])), counts, pages, documents: [...documents.values()], rows,
      status: Object.values(counts).some(value => value > 0) || pages.length !== 2 || pages.some(page => page.attachmentLate || !page.setup.cdp || !page.snapshot)
        || !windows?.webLogin?.total?.finishedAt || !windows?.nativeLogin?.total?.finishedAt ? 'incomplete' : 'complete',
      boundaries: BOUNDARIES }
    assertReadDiagnosticsReport(report)
    await writeFile(path, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
    return { status: report.status, rows: rows.length, counts: { ...counts } }
  }
  return { attach, snapshot, write }
}
export function assertReadDiagnosticsReport(report) {
  assert.ok(exactKeys(report, new Set(['version', 'revision', 'purpose', 'limits', 'windows', 'counts', 'pages', 'documents', 'rows', 'status', 'boundaries'])))
  assert.equal(report.version, 1)
  assert.match(report.revision, /^[0-9a-f]{40}$/)
  assert.equal(report.purpose, 'causal-diagnostic-only')
  assert.deepEqual(report.limits, LIMITS)
  assert.ok(['complete', 'incomplete'].includes(report.status))
  assert.deepEqual(report.boundaries, BOUNDARIES)
  assert.ok(exactKeys(report.counts, new Set(COUNT_KEYS)) && Object.keys(report.counts).length === COUNT_KEYS.length)
  assert.ok(Object.values(report.counts).every(integer))
  assert.ok(exactKeys(report.windows, new Set(['webLogin', 'nativeLogin'])) && Object.keys(report.windows).length === 2)
  for (const window of Object.values(report.windows)) {
    assert.ok(exactKeys(window, new Set(['startedAt', 'finishedAt'])) && Object.keys(window).length === 2)
    for (const value of Object.values(window)) assert.ok(value === null || typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
  }
  assert.ok(Array.isArray(report.pages) && report.pages.length <= 2)
  const validSnapshot = value => exactKeys(value, new Set(['documentId', 'sequence', 'failures', 'pending', 'attempted', 'timeOrigin']))
    && typeof value.documentId === 'string' && UUID.test(value.documentId) && [value.sequence, value.failures, value.pending, value.attempted].every(integer) && finite(value.timeOrigin)
  for (const page of report.pages) {
    assert.ok(exactKeys(page, new Set(['id', 'client', 'attachmentLate', 'setup', 'closed', 'snapshot'])))
    assert.ok(integer(page.id) && ['webLogin', 'nativeLogin'].includes(page.client) && typeof page.attachmentLate === 'boolean' && typeof page.closed === 'boolean')
    assert.ok(exactKeys(page.setup, new Set(['binding', 'initScript', 'cdp'])) && Object.keys(page.setup).length === 3 && Object.values(page.setup).every(value => typeof value === 'boolean'))
    assert.ok(page.snapshot === null || validSnapshot(page.snapshot))
  }
  assert.ok(Array.isArray(report.documents) && report.documents.length <= LIMITS.documents)
  for (const document of report.documents) {
    assert.ok(exactKeys(document, new Set(['pageId', 'client', 'kind', 'documentId', 'sequence', 'timeOrigin', 'initializedWallMs', 'initializedMonotonicMs', 'late', 'lastSequence', 'sealed'])))
    assert.ok(integer(document.pageId) && ['webLogin', 'nativeLogin'].includes(document.client) && document.kind === 'document'
      && typeof document.documentId === 'string' && UUID.test(document.documentId) && document.sequence === 0
      && [document.timeOrigin, document.initializedWallMs, document.initializedMonotonicMs].every(finite)
      && typeof document.late === 'boolean' && integer(document.lastSequence) && typeof document.sealed === 'boolean')
  }
  const incomplete = Object.values(report.counts).some(value => value > 0) || report.pages.length !== 2 || report.pages.some(page => page.attachmentLate || !page.setup.cdp || !page.snapshot)
    || Object.values(report.windows).some(window => !window.startedAt || !window.finishedAt)
  assert.equal(report.status, incomplete ? 'incomplete' : 'complete')
  assert.ok(Array.isArray(report.rows) && report.rows.length <= LIMITS.rows)
  assert.ok(Buffer.byteLength(report.rows.map(row => JSON.stringify(row)).join('')) <= LIMITS.bytes)
  for (const row of report.rows) {
    assert.ok(integer(row.pageId) && finite(row.receivedWallMs))
    if (row.kind === 'product') {
      assert.ok(exactKeys(row, new Set(['kind', 'pageId', 'receivedWallMs', 'documentId', 'sequence', 'detail'])))
      assert.ok(typeof row.documentId === 'string' && UUID.test(row.documentId) && integer(row.sequence) && validDiagnosticDetail(row.detail))
    } else if (row.kind === 'document') {
      assert.ok(exactKeys(row, new Set(['kind', 'pageId', 'receivedWallMs', 'documentId', 'sequence', 'timeOrigin', 'initializedWallMs', 'initializedMonotonicMs', 'late'])))
      assert.ok(typeof row.documentId === 'string' && UUID.test(row.documentId) && row.sequence === 0 && finite(row.timeOrigin) && finite(row.initializedWallMs) && finite(row.initializedMonotonicMs) && typeof row.late === 'boolean')
    } else if (row.kind === 'seal') {
      assert.ok(exactKeys(row, new Set(['kind', 'pageId', 'receivedWallMs', 'documentId', 'sequence', 'failures', 'pending', 'attempted', 'timeOrigin'])))
      assert.ok(typeof row.documentId === 'string' && UUID.test(row.documentId) && [row.sequence, row.failures, row.pending, row.attempted].every(integer) && finite(row.timeOrigin))
    } else if (row.kind === 'network') {
      assert.ok(exactKeys(row, new Set(['kind', 'phase', 'pageId', 'receivedWallMs', 'requestId', 'loaderId', 'method', 'family', 'cdpMonotonicMs', 'wallMs', 'redirected', 'status'])))
      assert.ok(['dispatch', 'headers', 'complete', 'failed'].includes(row.phase) && integer(row.requestId))
      if (row.phase === 'dispatch') assert.ok(integer(row.loaderId) && (METHODS.has(row.method) || row.method === 'OTHER') && FAMILIES.has(row.family) && typeof row.redirected === 'boolean')
      if (row.status !== undefined) assert.ok(row.status === null || integer(row.status))
      assert.ok(row.cdpMonotonicMs === null || finite(row.cdpMonotonicMs))
      if (row.wallMs !== undefined) assert.ok(row.wallMs === null || finite(row.wallMs))
    } else if (row.kind === 'navigation') {
      assert.ok(exactKeys(row, new Set(['kind', 'phase', 'pageId', 'receivedWallMs', 'loaderId', 'cdpMonotonicMs'])))
      assert.ok(['committed', 'domcontentloaded'].includes(row.phase))
      if (row.loaderId !== undefined) assert.ok(integer(row.loaderId))
      if (row.cdpMonotonicMs !== undefined) assert.ok(row.cdpMonotonicMs === null || finite(row.cdpMonotonicMs))
    } else assert.fail('DIAGNOSTIC_ROW_KIND')
  }
  return true
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== 'audit' || process.argv.length !== 4) throw new Error('READ_DIAGNOSTIC_AUDIT_ARGUMENTS')
  assertReadDiagnosticsReport(JSON.parse(await readFile(resolve(process.argv[3]), 'utf8')))
  console.log('read-diagnostics closed schema: passed (not a budget or causal verdict)')
}
