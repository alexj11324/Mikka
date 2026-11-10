// TEMPORARY issue #1512 metadata collector. Unknown console text is discarded.
import { DIAGNOSTIC_PREFIX, validateReadDiagnosticDump } from './issue1512-native-reads.mjs'
const MAX_DUMPS = 128, MAX_ROWS = 32768
const cloneDump = dump => ({ ...dump, realm: [...dump.realm], rows: dump.rows.map(row => [...row]) })
export function createReadDiagnosticCollector() {
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
export function installMainReadDiagnostic(contents) {
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

export function validateReadDiagnosticCollection(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const names = ['version', 'expectedDocuments', 'invalidDumps', 'droppedDumps', 'dumps']
  return Object.keys(raw).length === names.length && names.every(name => Object.hasOwn(raw, name))
    && raw.version === 1 && [raw.expectedDocuments, raw.invalidDumps, raw.droppedDumps].every(value => Number.isSafeInteger(value) && value >= 0)
    && Array.isArray(raw.dumps) && raw.dumps.length <= MAX_DUMPS
    && raw.dumps.every(dump => validateReadDiagnosticDump(dump) && dump.reason === 1)
    && raw.dumps.reduce((count, dump) => count + dump.rows.length, 0) <= MAX_ROWS
}

/** Validate per-realm prefixes and dump order. A phase view does not consume a dump. */
export function reviewReadDiagnosticCollection(raw, current) {
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
