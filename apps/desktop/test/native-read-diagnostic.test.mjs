import test from 'node:test'
import assert from 'node:assert/strict'
import { createReadDiagnostic, DIAGNOSTIC_PREFIX, DIAGNOSTIC_ACTIONS, DE, validateReadDiagnosticDump, validateReadDiagnosticRow } from '../../../lib/diagnostics/issue1512-native-reads.mjs'
import { createReadDiagnosticCollector, installMainReadDiagnostic, reviewReadDiagnosticCollection, validateReadDiagnosticCollection } from '../../../lib/diagnostics/issue1512-read-collector.mjs'

const recorder = (realm = [1, 2], limit = 4096) => {
  let time = 0
  return createReadDiagnostic({ now: () => ++time, timeOrigin: 1000, realm, limit })
}
const complete = (read = recorder()) => {
  const collector = createReadDiagnosticCollector()
  collector.document()
  return { read, collector, review: () => reviewReadDiagnosticCollection(collector.snapshot(), read.dump(2)) }
}

test('default module import exposes no browser or main collector in Node', () => {
  assert.equal(globalThis.__mikka1512ReadDiagnostic, undefined)
  assert.equal(globalThis.__mikka1512ReadDiagnosticMain, undefined)
})
test('fresh recorder exports a valid numeric-only realm prefix', () => {
  const dump = recorder().dump(2)
  assert.equal(validateReadDiagnosticDump(dump), true)
  assert.deepEqual(dump.rows[0], [1, 1, DE.realm])
  assert.equal(dump.reason, 2)
})
test('phase views are nondestructive and do not advance the next pagehide dump', () => {
  const read = recorder()
  read.record(DE.pendingCapture, 8)
  const first = read.dump(2), second = read.dump(2), hidden = read.dump(1)
  assert.deepEqual(first, second)
  assert.equal(hidden.dump, 1)
  assert.deepEqual(hidden.rows, first.rows)
  assert.equal(read.dump(2).dump, 2)
  assert.deepEqual(read.dump(2).rows, [])
})
test('pagehide dump sequence keeps only newly recorded prefix rows', () => {
  const read = recorder()
  const first = read.dump(1)
  read.record(DE.pendingCapture, 8)
  const second = read.dump(1)
  assert.equal(first.dump, 1)
  assert.equal(second.dump, 2)
  assert.equal(second.rows.length, 1)
  assert.equal(second.rows[0][0], first.through + 1)
  assert.equal(second.recorded, 2)
})
test('record cap retains the initial prefix and explicitly counts dropped events', () => {
  const read = recorder([1, 2], 2)
  read.record(DE.pendingCapture, 8)
  read.record(DE.pendingCapture, 9)
  const dump = read.dump(2)
  assert.equal(dump.rows.length, 2)
  assert.equal(dump.dropped, 1)
  assert.equal(dump.through, 3)
  assert.equal(dump.overflow, true)
  assert.equal(validateReadDiagnosticDump(dump), true)
})
test('unknown values are never serialized and are counted as lost diagnostics', () => {
  const read = recorder()
  read.record(DE.pendingCapture, 'private raw owner and request body')
  const dump = read.dump(2)
  assert.equal(dump.dropped, 1)
  assert.equal(JSON.stringify(dump).includes('private'), false)
  assert.equal(validateReadDiagnosticDump(dump), true)
})
test('key and object IDs are local stable integers without copying key text', () => {
  const read = recorder(), owner = {}
  const secret = 'owner@example.test?workspace=secret'
  assert.equal(read.key(secret), read.key(secret))
  assert.equal(read.object(owner), read.object(owner))
  assert.notEqual(read.object(owner), read.object({}))
  assert.equal(JSON.stringify(read.dump(2)).includes(secret), false)
})
test('key-map saturation marks diagnostics incomplete without retaining more keys', () => {
  const read = recorder()
  for (let i = 0; i < 1024; i++) assert.ok(read.key(String(i)) > 0)
  assert.equal(read.key('overflow-only'), 0)
  const dump = read.dump(2)
  assert.equal(dump.dropped, 1)
  assert.equal(validateReadDiagnosticDump(dump), true)
})
test('unknown action names collapse to the closed other code', () => {
  const read = recorder()
  read.action('private arbitrary content')
  const row = read.dump(2).rows.at(-1)
  assert.equal(row[2], DE.action)
  assert.equal(row[5], 0)
  assert.equal(JSON.stringify(row).includes('private'), false)
})
test('nested synchronous diagnostic scopes restore their parent even on throw', () => {
  const read = recorder(), failure = new Error('test')
  read.withRead(11, () => {
    assert.equal(read.current(), 11)
    assert.throws(() => read.withRead(22, () => { throw failure }), error => error === failure)
    assert.equal(read.current(), 11)
  })
  assert.equal(read.current(), 0)
})
test('a scope returns the exact promise and never remains ambient across await', async () => {
  const read = recorder(), promise = Promise.resolve(4)
  assert.equal(read.withRead(11, () => promise), promise)
  assert.equal(read.current(), 0)
  await promise
  assert.equal(read.current(), 0)
})
test('two interleaved delayed reads restore only their captured local integer', async () => {
  const read = recorder()
  const run = id => read.withRead(id, () => {
    const token = read.current()
    return Promise.resolve().then(() => {
      assert.equal(read.current(), 0)
      return read.withRead(token, () => read.action('coordinator.syncCoordinatorChat'))
    })
  })
  await Promise.all([run(11), run(22)])
  const rows = read.dump(2).rows.filter(row => row[2] === DE.action)
  assert.deepEqual(rows.map(row => row[4]), [11, 22])
  assert.equal(read.current(), 0)
})
test('all event arities and branch-specific variants are accepted', () => {
  const values = [
    [DE.realm], [DE.readBegin, 1, 2, 3, 4], [DE.pendingCapture, 1],
    [DE.pendingNotify, 1, 2], [DE.pendingRevoke, 1, 1], [DE.proof, 1, 2],
    [DE.readReceive, 1, 0, 3], [DE.readSettle, 1, 1, 3, 1, 0], [DE.readAccept, 1],
    [DE.action, 1, 0, 0], [DE.enqueue, 1], [DE.dispatch, 1, 0, 0, 1],
    [DE.dispatchAction, 1, 2], [DE.response, 1, 200],
    [DE.subscription, 1, 2, 3, 4, 0, 1], [DE.invalidate, 1, 2, 3, 4, 4, 0, 0, 0, 1],
    [DE.flush, 1, 2, 3, 4, 1, 0], [DE.scopeReset, 1, 2], [DE.incoming, 1, 2, 0, 3, 0],
  ]
  for (let branch = 1; branch <= 13; branch++) values.push([DE.fresh, 1, 2, 3, 4, branch,
    ...(branch <= 5 ? [6, 7] : [6, 8, 9].includes(branch) ? [] : [6])])
  for (let state = 1; state <= 6; state++) values.push([DE.channel, 1, state, 2, ...(state <= 3 ? [] : [state === 5 ? 1 : 4])])
  for (const value of values) assert.equal(validateReadDiagnosticRow([1, 1, ...value]), true, String(value))
})
test('missing fields, extra fields and unknown event enums are rejected', () => {
  assert.equal(validateReadDiagnosticRow([1, 1, DE.pendingNotify, 1]), false)
  assert.equal(validateReadDiagnosticRow([1, 1, DE.realm, 1]), false)
  assert.equal(validateReadDiagnosticRow([1, 1, 22]), false)
  assert.equal(validateReadDiagnosticRow([1, 1, DE.pendingRevoke, 1, 4]), false)
  assert.equal(validateReadDiagnosticRow([1, 1, DE.action, 1, 0, DIAGNOSTIC_ACTIONS.length]), false)
  assert.equal(validateReadDiagnosticRow([1, 1, DE.dispatch, 1, 0, 0, 3]), false)
  assert.equal(validateReadDiagnosticRow([1, 1, DE.response, 1, 999]), false)
  assert.equal(validateReadDiagnosticRow([1, 1, DE.invalidate, 1, 2, 3, 4, 4, 0, 0, 0, 3]), false)
})
test('dump schema rejects unlisted fields, inconsistent counters and unsafe integers', () => {
  const valid = recorder().dump(2)
  assert.equal(validateReadDiagnosticDump({ ...valid, payload: 'not allowed' }), false)
  assert.equal(validateReadDiagnosticDump({ ...valid, through: 2 }), false)
  assert.equal(validateReadDiagnosticDump({ ...valid, realm: [Number.MAX_SAFE_INTEGER + 1, 2] }), false)
  assert.equal(validateReadDiagnosticDump({ ...valid, rows: [[1, 1, DE.pendingNotify, 1]] }), false)
})
test('one current document is complete without any pagehide', () => {
  const value = complete()
  assert.equal(value.review().status, 'complete')
})
test('two documents link one retired pagehide plus the current nondestructive view', () => {
  const first = recorder([1, 2]), second = recorder([3, 4]), collector = createReadDiagnosticCollector()
  collector.document()
  assert.equal(collector.consoleMessage(DIAGNOSTIC_PREFIX + JSON.stringify(first.dump(1))), true)
  collector.document()
  const result = reviewReadDiagnosticCollection(collector.snapshot(), second.dump(2))
  assert.equal(result.status, 'complete')
  assert.equal(result.realms.length, 2)
})
test('lost navigation-page dump is incomplete instead of inferred from the new document', () => {
  const value = complete()
  value.collector.document()
  const result = value.review()
  assert.equal(result.status, 'incomplete')
  assert.ok(result.reasons.includes(11))
})
test('a missing current realm is incomplete', () => {
  const value = complete()
  const result = reviewReadDiagnosticCollection(value.collector.snapshot(), null)
  assert.equal(result.status, 'incomplete')
  assert.ok(result.reasons.includes(10))
})
test('duplicate pagehide dump is incomplete', () => {
  const value = complete(), dump = value.read.dump(1)
  value.collector.accept(dump); value.collector.accept(dump)
  assert.equal(value.review().status, 'incomplete')
  assert.ok(value.review().reasons.includes(6))
})
test('a skipped dump number is incomplete', () => {
  const value = complete(), dump = { ...value.read.dump(1), dump: 2 }
  value.collector.accept(dump)
  assert.ok(value.review().reasons.includes(6))
})
test('row sequence gaps and backward time are incomplete', () => {
  const value = complete(), dump = value.read.dump(2)
  const skipped = { ...dump, rows: [[2, 1, DE.realm]] }
  assert.ok(reviewReadDiagnosticCollection(value.collector.snapshot(), skipped).reasons.includes(8))
  const backward = recorder()
  backward.record(DE.pendingCapture, 8)
  const bad = backward.dump(2); bad.rows[1][1] = 0
  assert.ok(reviewReadDiagnosticCollection(value.collector.snapshot(), bad).reasons.includes(8))
})
test('overflow remains incomplete even when every exported row validates', () => {
  const value = complete(recorder([1, 2], 1))
  value.read.record(DE.pendingCapture, 8)
  assert.ok(value.review().reasons.includes(9))
})
test('ordinary console text and payload are not retained', () => {
  const collector = createReadDiagnosticCollector()
  assert.equal(collector.consoleMessage('private normal console message'), false)
  assert.equal(collector.snapshot().invalidDumps, 0)
  assert.equal(JSON.stringify(collector.snapshot()).includes('private'), false)
})
test('malformed prefixed messages are counted without retaining their bytes', () => {
  const collector = createReadDiagnosticCollector()
  collector.consoleMessage(DIAGNOSTIC_PREFIX + '{"token":"private","bad":true}')
  collector.consoleMessage(DIAGNOSTIC_PREFIX + 'not-json')
  assert.equal(collector.snapshot().invalidDumps, 2)
  assert.equal(JSON.stringify(collector.snapshot()).includes('private'), false)
})
test('main collector is attached synchronously and rejects other frame dumps', () => {
  const listeners = new Map(), frame = { frameTreeNodeId: 10 }, contents = { mainFrame: frame, on: (name, fn) => listeners.set(name, fn) }
  try {
    installMainReadDiagnostic(contents)
    assert.ok(listeners.has('dom-ready'))
    assert.ok(listeners.has('console-message'))
    listeners.get('dom-ready')()
    const dump = recorder().dump(1)
    listeners.get('console-message')({ frame: { frameTreeNodeId: 11 }, message: DIAGNOSTIC_PREFIX + JSON.stringify(dump) })
    const raw = globalThis.__mikka1512ReadDiagnosticMain.snapshot()
    assert.equal(raw.expectedDocuments, 1)
    assert.equal(raw.invalidDumps, 1)
    assert.equal(raw.dumps.length, 0)
  } finally { delete globalThis.__mikka1512ReadDiagnosticMain }
})
test('main collector captures prior document before any runner firstWindow hook', () => {
  const listeners = new Map(), frame = { frameTreeNodeId: 10 }, contents = { mainFrame: frame, on: (name, fn) => listeners.set(name, fn) }
  try {
    installMainReadDiagnostic(contents)
    listeners.get('dom-ready')()
    listeners.get('console-message')({ frame, message: DIAGNOSTIC_PREFIX + JSON.stringify(recorder().dump(1)) })
    const raw = globalThis.__mikka1512ReadDiagnosticMain.snapshot()
    assert.equal(raw.dumps.length, 1)
    assert.equal(validateReadDiagnosticCollection(raw), true)
  } finally { delete globalThis.__mikka1512ReadDiagnosticMain }
})
test('raw collector schema never accepts unlisted top-level data', () => {
  const collector = createReadDiagnosticCollector()
  assert.equal(validateReadDiagnosticCollection({ ...collector.snapshot(), headers: { private: true } }), false)
})
test('pending reads remain visible without waiting for a settle or adding a timer', () => {
  const value = complete()
  value.read.record(DE.readBegin, 4, 2, 3, 5)
  value.read.record(DE.pendingCapture, 4)
  const report = value.review()
  assert.equal(report.status, 'complete')
  assert.equal(report.realms[0].rows.some(row => row[2] === DE.readSettle), false)
  assert.equal(report.realms[0].rows.at(-1)[2], DE.pendingCapture)
})

test('an unloading old frame object with the same stable top-frame tree ID is accepted', () => {
  const listeners = new Map(), currentFrame = { frameTreeNodeId: 42 }
  const oldFrame = { frameTreeNodeId: 42 }, contents = { mainFrame: currentFrame, on: (name, fn) => listeners.set(name, fn) }
  try {
    installMainReadDiagnostic(contents)
    listeners.get('dom-ready')()
    assert.notEqual(oldFrame, currentFrame)
    listeners.get('console-message')({ frame: oldFrame, message: DIAGNOSTIC_PREFIX + JSON.stringify(recorder().dump(1)) })
    const raw = globalThis.__mikka1512ReadDiagnosticMain.snapshot()
    assert.equal(raw.dumps.length, 1)
    assert.equal(raw.invalidDumps, 0)
    assert.equal(JSON.stringify(raw).includes('frameTreeNodeId'), false)
  } finally { delete globalThis.__mikka1512ReadDiagnosticMain }
})
test('missing, negative, fractional, nonfinite or unsafe tree IDs are rejected on either side', () => {
  const invalid = [undefined, null, '10', -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]
  for (const value of invalid) for (const side of ['source', 'main']) {
    const listeners = new Map()
    const contents = { mainFrame: { frameTreeNodeId: side === 'main' ? value : 10 }, on: (name, fn) => listeners.set(name, fn) }
    try {
      installMainReadDiagnostic(contents)
      listeners.get('console-message')({ frame: { frameTreeNodeId: side === 'source' ? value : 10 },
        message: DIAGNOSTIC_PREFIX + JSON.stringify(recorder().dump(1)) })
      const raw = globalThis.__mikka1512ReadDiagnosticMain.snapshot()
      assert.equal(raw.dumps.length, 0)
      assert.equal(raw.invalidDumps, 1)
    } finally { delete globalThis.__mikka1512ReadDiagnosticMain }
  }
})
test('deleted-frame and main-frame getter failures remain diagnostic loss only', () => {
  for (const side of ['source-frame', 'source-id', 'main-frame', 'main-id']) {
    const listeners = new Map(), frame = { frameTreeNodeId: 10 }
    const contents = { mainFrame: frame, on: (name, fn) => listeners.set(name, fn) }
    const details = { frame: { frameTreeNodeId: 10 }, message: DIAGNOSTIC_PREFIX + JSON.stringify(recorder().dump(1)) }
    const fail = { get() { throw new Error('deleted frame fixture') } }
    if (side === 'source-frame') Object.defineProperty(details, 'frame', fail)
    if (side === 'source-id') Object.defineProperty(details.frame, 'frameTreeNodeId', fail)
    if (side === 'main-frame') Object.defineProperty(contents, 'mainFrame', fail)
    if (side === 'main-id') Object.defineProperty(frame, 'frameTreeNodeId', fail)
    try {
      installMainReadDiagnostic(contents)
      listeners.get('console-message')(details)
      const raw = globalThis.__mikka1512ReadDiagnosticMain.snapshot()
      assert.equal(raw.dumps.length, 0)
      assert.equal(raw.invalidDumps, 1)
    } finally { delete globalThis.__mikka1512ReadDiagnosticMain }
  }
})
