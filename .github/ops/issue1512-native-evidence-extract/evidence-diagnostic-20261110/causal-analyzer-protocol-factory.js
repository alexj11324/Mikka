function exactDiagnosticProtocol(){
// TEMPORARY issue #1512 diagnosis. This file is never a product freshness proof.
// Hot paths append numeric tuples only. Serialization happens at pagehide or
// after the existing measurement boundary; no timer, I/O, retry or SDK is used.
const DIAGNOSTIC_PREFIX = 'MIKKA_1512_READ_DIAGNOSTIC_V1 '
const DIAGNOSTIC_LIMIT = 4096
const DIAGNOSTIC_ACTIONS = Object.freeze([
  'other', 'desktop.bootstrap', 'desktop.session', 'desktop.readBatch',
  'task-runs.pollTaskRuns', 'coordinator.pollBotChatSummaries', 'bots.pollBots',
  'teams.listTeams', 'team-relations.listProjectTeams', 'projects.listProjects',
  'coordinator.syncCoordinatorChat', 'issues.syncIssueList', 'task-runs.syncThreadList',
  'execution-settings.getBotModelMenu', 'workspace.switchWorkspace',
])
const DIAGNOSTIC_KINDS = Object.freeze([
  'other', 'workspace_settings', 'task_run_list', 'bot_chat_list', 'bot_chat',
  'issue_list', 'thread_list', 'bot_list', 'project', 'group_list',
])
const DE = Object.freeze({
  realm: 1, readBegin: 2, pendingCapture: 3, pendingNotify: 4, pendingRevoke: 5,
  proof: 6, readReceive: 7, readSettle: 8, readAccept: 9,
  action: 10, enqueue: 11, dispatch: 12, dispatchAction: 13, response: 14,
  fresh: 15, channel: 16, subscription: 17, invalidate: 18, flush: 19, scopeReset: 20, incoming: 21,
})
const nonnegative = value => Number.isFinite(value) && value >= 0
const integer = value => Number.isSafeInteger(value) && value >= 0
const actionCode = name => Math.max(0, DIAGNOSTIC_ACTIONS.indexOf(name))
const kindCode = name => Math.max(0, DIAGNOSTIC_KINDS.indexOf(name))

/** Injected clocks make the recorder testable without browser, network or data. */
function createReadDiagnostic({ now, timeOrigin, realm, limit = DIAGNOSTIC_LIMIT }) {
  if (typeof now !== 'function' || !nonnegative(timeOrigin) || !Array.isArray(realm)
    || realm.length !== 2 || !realm.every(integer) || !Number.isInteger(limit) || limit < 1 || limit > DIAGNOSTIC_LIMIT) throw new Error('READ_DIAGNOSTIC_OPTIONS')
  const objects = new WeakMap(), keys = new Map(), rows = []
  let nextId = 0, seq = 0, dumped = 0, dumpSequence = 0, dropped = 0, currentRead = 0
  const next = () => ++nextId
  const record = (event, ...values) => {
    try {
      seq++
      if (rows.length >= limit) { dropped++; return }
      const at = now()
      if (!nonnegative(at) || !Number.isInteger(event) || event < 1 || event > 21
        || values.length > 13 || !values.every(integer)) { dropped++; return }
      rows.push([seq, at, event, ...values])
    } catch { dropped++ }
  }
  const object = value => {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return 0
    let id = objects.get(value)
    if (id === undefined) { id = next(); objects.set(value, id) }
    return id
  }
  const key = value => {
    if (typeof value !== 'string') return 0
    let id = keys.get(value)
    if (id === undefined) {
      if (keys.size >= 1024) { record(0); return 0 }
      id = next(); keys.set(value, id)
    }
    return id
  }
  const withRead = (read, run) => {
    const previous = currentRead
    currentRead = integer(read) ? read : 0
    try { return run() } finally { currentRead = previous }
  }
  const action = name => {
    const id = next()
    record(DE.action, id, currentRead, actionCode(name))
    return id
  }
  const dump = reason => {
    if (![1, 2, 3].includes(reason)) throw new Error('READ_DIAGNOSTIC_DUMP_REASON')
    const result = { version: 1, realm: [...realm], timeOrigin, dump: reason === 1 ? ++dumpSequence : dumpSequence + 1, reason,
      through: seq, recorded: rows.length, dropped, overflow: dropped > 0,
      rows: rows.slice(dumped).map(row => [...row]) }
    if (reason === 1) dumped = rows.length
    return result
  }
  record(DE.realm)
  return { record, object, key, next, withRead, current: () => currentRead, action, dump }
}

let active
if (typeof window !== 'undefined' && typeof performance !== 'undefined'
  && globalThis.__mikka1512ReadDiagnosticEnabled === true && window.top === window) {
  try {
    const realm = Array.from(crypto.getRandomValues(new Uint32Array(2)))
    active = createReadDiagnostic({ now: () => performance.now(), timeOrigin: performance.timeOrigin, realm })
    Object.defineProperty(globalThis, '__mikka1512ReadDiagnostic', {
      value: Object.freeze({ dump: reason => active.dump(reason) }), configurable: false, writable: false,
    })
    window.addEventListener('pagehide', () => {
      try { console.debug(DIAGNOSTIC_PREFIX + JSON.stringify(active.dump(1))) } catch { /* diagnostic loss remains incomplete */ }
    })
  } catch { active = undefined }
}

const diagRecord = (event, ...values) => { active?.record(event, ...values) }
const diagObject = value => active?.object(value) ?? 0
const diagKey = value => active?.key(value) ?? 0
const diagNext = () => active?.next() ?? 0
const diagCurrentRead = () => active?.current() ?? 0
const diagWithRead = (read, run) => active ? active.withRead(read, run) : run()
const diagAction = name => active?.action(name) ?? 0
const diagActionCode = actionCode
const diagKindCode = kindCode

/** Validate only the closed numeric schema; never retain unknown console text. */
function validateReadDiagnosticDump(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const names = ['version', 'realm', 'timeOrigin', 'dump', 'reason', 'through', 'recorded', 'dropped', 'overflow', 'rows']
  if (Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) return false
  return value.version === 1 && Array.isArray(value.realm) && value.realm.length === 2 && value.realm.every(integer)
    && nonnegative(value.timeOrigin) && integer(value.dump) && value.dump > 0 && [1, 2, 3].includes(value.reason)
    && integer(value.through) && integer(value.recorded) && value.recorded <= DIAGNOSTIC_LIMIT
    && integer(value.dropped) && value.overflow === (value.dropped > 0) && Array.isArray(value.rows)
    && value.recorded + value.dropped === value.through
    && value.rows.length <= DIAGNOSTIC_LIMIT && value.rows.every(validateReadDiagnosticRow)
}

function validateReadDiagnosticRow(row) {
  if (!Array.isArray(row) || row.length < 3 || row.length > 16
    || !integer(row[0]) || row[0] < 1 || !nonnegative(row[1]) || !row.slice(2).every(integer)) return false
  const event = row[2], values = row.slice(3), count = values.length
  const boolean = value => value === 0 || value === 1
  const arity = [0, 0, 4, 1, 2, 2, 2, 3, 5, 1, 3, 1, 4, 2, 2, -1, -1, 6, 9, 6, 2, 5]
  if (event < 1 || event > 21 || (arity[event] >= 0 && count !== arity[event])) return false
  if (event === DE.pendingRevoke) return values[1] >= 1 && values[1] <= 3
  if (event === DE.readSettle) return values[1] >= 1 && values[1] <= 3 && boolean(values[3]) && boolean(values[4])
  if (event === DE.action) return values[2] < DIAGNOSTIC_ACTIONS.length
  if (event === DE.dispatch) return values[1] < DIAGNOSTIC_ACTIONS.length && (values[3] === 1 || values[3] === 2)
  if (event === DE.response) return values[1] === 0 || values[1] >= 100 && values[1] <= 599
  if (event === DE.fresh) {
    const branch = values[4]
    return branch >= 1 && branch <= 13
      && count === (branch <= 5 ? 7 : [6, 8, 9].includes(branch) ? 5 : 6)
  }
  if (event === DE.channel) return values[1] >= 1 && values[1] <= 6
    && count === (values[1] <= 3 ? 3 : 4) && (values[1] !== 5 || boolean(values[3]))
  if (event === DE.subscription) return values[4] < DIAGNOSTIC_KINDS.length && (values[5] === 1 || values[5] === 2)
  if (event === DE.invalidate) return boolean(values[5]) && boolean(values[6]) && values[8] <= 2
  if (event === DE.flush) return boolean(values[4])
  if (event === DE.incoming) return values[2] < DIAGNOSTIC_KINDS.length
  return true
}

// TEMPORARY issue #1512 metadata collector. Unknown console text is discarded.

const MAX_DUMPS = 128, MAX_ROWS = 32768
const cloneDump = dump => ({ ...dump, realm: [...dump.realm], rows: dump.rows.map(row => [...row]) })
function createReadDiagnosticCollector() {
  const dumps = []
  let expectedDocuments = 0, invalidDumps = 0, droppedDumps = 0, totalRows = 0
  const document = () => { expectedDocuments++ }
  const accept = dump => {
    if (!validateReadDiagnosticDump(dump) || dump.reason !== 1) { invalidDumps++; return false }
    if (dumps.length >= MAX_DUMPS || totalRows + dump.rows.length > MAX_ROWS) { droppedDumps++; return false }
    totalRows += dump.rows.length
    dumps.push(cloneDump(dump))
    return true
  }
  const consoleMessage = message => {
    if (typeof message !== 'string' || !message.startsWith(DIAGNOSTIC_PREFIX)) return false
    if (message.length > 2 * 1024 * 1024) { invalidDumps++; return false }
    try { return accept(JSON.parse(message.slice(DIAGNOSTIC_PREFIX.length))) }
    catch { invalidDumps++; return false }
  }
  const invalid = () => { invalidDumps++ }
  const snapshot = () => ({ version: 1, expectedDocuments, invalidDumps, droppedDumps, dumps: dumps.map(cloneDump) })
  return { document, accept, consoleMessage, invalid, snapshot }
}

/** Main installs this before its first loadURL; no credentials or IPC are exposed. */
function installMainReadDiagnostic(contents) {
  const collector = createReadDiagnosticCollector()
  contents.on('dom-ready', collector.document)
  contents.on('console-message', details => {
    if (typeof details?.message !== 'string' || !details.message.startsWith(DIAGNOSTIC_PREFIX)) return
    let sourceTreeNode, mainTreeNode
    try {
      sourceTreeNode = details.frame?.frameTreeNodeId
      mainTreeNode = contents.mainFrame?.frameTreeNodeId
    } catch { collector.invalid(); return }
    if (!Number.isSafeInteger(sourceTreeNode) || sourceTreeNode < 0
      || !Number.isSafeInteger(mainTreeNode) || mainTreeNode < 0 || sourceTreeNode !== mainTreeNode) { collector.invalid(); return }
    collector.consoleMessage(details.message)
  })
  Object.defineProperty(globalThis, '__mikka1512ReadDiagnosticMain', {
    value: Object.freeze({ snapshot: collector.snapshot }), configurable: true, writable: false,
  })
}

function validateReadDiagnosticCollection(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const names = ['version', 'expectedDocuments', 'invalidDumps', 'droppedDumps', 'dumps']
  return Object.keys(raw).length === names.length && names.every(name => Object.hasOwn(raw, name))
    && raw.version === 1 && [raw.expectedDocuments, raw.invalidDumps, raw.droppedDumps].every(value => Number.isSafeInteger(value) && value >= 0)
    && Array.isArray(raw.dumps) && raw.dumps.length <= MAX_DUMPS
    && raw.dumps.every(dump => validateReadDiagnosticDump(dump) && dump.reason === 1)
    && raw.dumps.reduce((count, dump) => count + dump.rows.length, 0) <= MAX_ROWS
}

/** Validate per-realm prefixes and dump order. A phase view does not consume a dump. */
function reviewReadDiagnosticCollection(raw, current) {
  const reasons = new Set(), realms = new Map()
  const reason = value => { reasons.add(value) }
  if (!validateReadDiagnosticCollection(raw)) return { version: 1, status: 'incomplete', reasons: [1], expectedDocuments: 0, realms: [] }
  if (raw.invalidDumps) reason(2)
  if (raw.droppedDumps) reason(3)
  const visit = (dump, view) => {
    if (!validateReadDiagnosticDump(dump) || (view ? dump.reason !== 2 && dump.reason !== 3 : dump.reason !== 1)) { reason(4); return }
    const key = dump.realm.join(':')
    let realm = realms.get(key)
    if (!realm) {
      if (realms.size >= 64) { reason(3); return }
      realm = { realm: [...dump.realm], timeOrigin: dump.timeOrigin, dumps: 0, recorded: 0, through: 0, dropped: 0, lastSeq: 0, lastTime: 0, rows: [], current: false }
      realms.set(key, realm)
    }
    if (realm.timeOrigin !== dump.timeOrigin) reason(5)
    if (dump.dump !== realm.dumps + 1) reason(6)
    if (dump.recorded !== realm.recorded + dump.rows.length || dump.through < realm.through || dump.dropped < realm.dropped) reason(7)
    for (const row of dump.rows) {
      if (row[0] <= realm.lastSeq || row[0] > dump.through || row[1] < realm.lastTime) reason(8)
      if (!dump.dropped && row[0] !== realm.lastSeq + 1) reason(8)
      realm.lastSeq = row[0]; realm.lastTime = row[1]
      if (realm.rows.length < 4096) realm.rows.push([...row]); else reason(3)
    }
    if (dump.dropped || dump.overflow) reason(9)
    if (!dump.dropped && realm.lastSeq !== dump.through) reason(8)
    realm.recorded = dump.recorded; realm.through = dump.through; realm.dropped = dump.dropped
    if (view) realm.current = true
    else realm.dumps++
  }
  for (const dump of raw.dumps) visit(dump, false)
  if (current === null || current === undefined) reason(10)
  else visit(current, true)
  if (realms.size !== raw.expectedDocuments) reason(11)
  if ([...realms.values()].filter(realm => realm.current).length !== 1) reason(12)
  const values = [...realms.values()]
  if (values.some(realm => !realm.current && !realm.dumps)) reason(13)
  return { version: 1, status: reasons.size ? 'incomplete' : 'complete', reasons: [...reasons].sort((a, b) => a - b),
    expectedDocuments: raw.expectedDocuments, realms: values }
}

return {createReadDiagnostic,createReadDiagnosticCollector,validateReadDiagnosticDump,validateReadDiagnosticCollection,reviewReadDiagnosticCollection};
}
