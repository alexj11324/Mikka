// TEMPORARY issue #1512 diagnosis. This file is never a product freshness proof.
// Hot paths append numeric tuples only. Serialization happens at pagehide or
// after the existing measurement boundary; no timer, I/O, retry or SDK is used.
export const DIAGNOSTIC_PREFIX = 'MIKKA_1512_READ_DIAGNOSTIC_V1 '
export const DIAGNOSTIC_LIMIT = 4096
export const DIAGNOSTIC_ACTIONS = Object.freeze([
  'other', 'desktop.bootstrap', 'desktop.session', 'desktop.readBatch',
  'task-runs.pollTaskRuns', 'coordinator.pollBotChatSummaries', 'bots.pollBots',
  'teams.listTeams', 'team-relations.listProjectTeams', 'projects.listProjects',
  'coordinator.syncCoordinatorChat', 'issues.syncIssueList', 'task-runs.syncThreadList',
  'execution-settings.getBotModelMenu', 'workspace.switchWorkspace',
])
export const DIAGNOSTIC_KINDS = Object.freeze([
  'other', 'workspace_settings', 'task_run_list', 'bot_chat_list', 'bot_chat',
  'issue_list', 'thread_list', 'bot_list', 'project', 'group_list',
])
export const DE = Object.freeze({
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
export function createReadDiagnostic({ now, timeOrigin, realm, limit = DIAGNOSTIC_LIMIT }) {
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

export const diagRecord = (event, ...values) => { active?.record(event, ...values) }
export const diagObject = value => active?.object(value) ?? 0
export const diagKey = value => active?.key(value) ?? 0
export const diagNext = () => active?.next() ?? 0
export const diagCurrentRead = () => active?.current() ?? 0
export const diagWithRead = (read, run) => active ? active.withRead(read, run) : run()
export const diagAction = name => active?.action(name) ?? 0
export const diagActionCode = actionCode
export const diagKindCode = kindCode

/** Validate only the closed numeric schema; never retain unknown console text. */
export function validateReadDiagnosticDump(value) {
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

export function validateReadDiagnosticRow(row) {
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
