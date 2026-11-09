import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import diagnostic from './db-query-diagnostics.cjs'
import { createLifecycleQueryCounter, queryCountDelta } from './lifecycle-query-counts.mjs'
import operations from './db-query-operations.cjs'
import sources from './db-query-unattributed-sources.cjs'

const { LIMITS, createQueryDiagnostics, projectQueryDiagnostics, statementStructure, readContext } = diagnostic
const key = Symbol.for('mikka.requestDiagnosticReaders')
const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const metadata = (n = 1, extra = {}) => ({ httpInvocationId: id(n), invocationId: id(n), route: '/api/devices/enrollment', method: 'GET', rpcAction: null, ...extra })
const identity = { pid: 77, runtime: 'nitro', startedAt: 1000 }
const fixture = (limits = LIMITS) => {
  const scope = new AsyncLocalStorage()
  const collector = createQueryDiagnostics({ globals: { [key]: new Set([() => scope.getStore()]) }, limits })
  return { scope, collector, record: (n, sql = 'SELECT id FROM session WHERE token=$1', context = metadata(), operation = '/api/devices/enrollment') =>
    scope.run(context, () => collector.record(n, sql, operation)) }
}
const window = (from, to) => ({ status: 'complete', checkpoints: [
  { phase: 'before', snapshot: { ...identity, queryCalls: from } },
  { phase: 'launch-to-usable', snapshot: { ...identity, queryCalls: to } },
] })
const event = (n, complete, extra = {}) => ({ msg: complete ? 'api_request' : 'api_request_started', invocationId: id(n),
  timestamp: `2026-11-09T00:00:0${complete ? 9 : 0}.000Z`, route: '/api/devices/enrollment', method: 'GET',
  ...(complete ? { status: 200 } : {}), ...extra })
const lines = events => events.map(value => JSON.stringify(value)).join('\n') + '\n'

test('SQL structures hash only a bounded parameterized subset and never read parameter/config getters', () => {
  const sql = 'SELECT "id" FROM "session" WHERE "token"=$1 AND "ownerId"=$2'
  const shape = statementStructure({ text: sql, values: ['PRIVATE_TOKEN', 'PRIVATE_OWNER'] }).value
  assert.equal(shape.normalizedStructureId, createHash('sha256').update(sql).digest('hex').slice(0, 12))
  assert.equal(shape.parameterCount, 2)
  for (const sql of ["SELECT 'PRIVATE_LITERAL'", "SELECT E'PRIVATE_LITERAL'", 'SELECT $$PRIVATE_LITERAL$$',
    'SELECT $tag$PRIVATE_LITERAL$tag$', 'SELECT 1 -- PRIVATE_COMMENT', 'SELECT /*PRIVATE_COMMENT*/ 1',
    'SELECT "PRIVATE\\IDENTIFIER"', 'SELECT "unterminated', "SELECT 'unterminated", 'SELECT 0x1234', 'SELECT 1_000',
    'SELECT $65536', 'SELECT '.repeat(LIMITS.sqlChars), 'SELECT \u0000']) {
    const value = statementStructure(sql)
    assert.ok(value.reason, sql.slice(0, 24)); assert.equal(value.value, undefined)
    assert.equal(JSON.stringify(value).includes('PRIVATE_'), false)
  }
  for (const [a, b] of [['SELECT 12345', 'SELECT 98765'], ['SELECT .12345', 'SELECT .98765'], ['SELECT -1.5e+3', 'SELECT 19.5e-2']]) {
    assert.equal(statementStructure(a).value.normalizedStructureId, statementStructure(b).value.normalizedStructureId)
  }
  let read = false
  assert.equal(statementStructure({ get text() { read = true; throw Error('PRIVATE_GETTER') } }).reason, 'statement_missing')
  assert.equal(read, false)
  const throwing = new Proxy({}, { getOwnPropertyDescriptor() { throw Error('PRIVATE_DESCRIPTOR') } })
  const f = fixture(); f.collector.checkpoint(0); f.record(1, throwing)
  const raw = f.collector.finish(identity, 1)
  assert.ok(raw.queries[0][1] > 0, 'a failed statement descriptor cannot erase the independently known request')
  assert.equal(raw.queries[0][2], 0); assert.equal(raw.reasons.statement_proxy, 1)
})

test('request diagnostics reject foreign registries, concurrent module scopes and arbitrary metadata', () => {
  for (const [registry, reason] of [[undefined, 'registry_unavailable'], [{}, 'registry_unavailable'],
    [new Set([() => undefined]), 'context_missing'], [new Set([() => metadata(), () => metadata(2)]), 'context_ambiguous'],
    [new Set([() => { throw Error('PRIVATE_ERROR') }]), 'context_read_failed'],
    [new Set([() => metadata(1, { route: '/api/PRIVATE_ROUTE' })]), 'context_invalid'],
    [new Set([() => metadata(1, { rpcAction: 'private.action' })]), 'context_invalid'],
    [new Set([() => metadata(1, { method: 'PRIVATE_METHOD' })]), 'context_invalid'],
    [new Set(Array.from({ length: 17 }, () => () => undefined)), 'registry_unavailable']]) {
    assert.deepEqual(readContext({ [key]: registry }), { reason })
  }
  assert.equal(readContext({ [key]: new Set([() => undefined, () => metadata()]) }).value.invocationId, id(1))
})

test('diagnostic safety: context identifiers accept primitive strings and read fields once', () => {
  const boxed = { toString: () => id(1), privateCanary: 'PRIVATE_BOXED_ID' }
  const bad = readContext({ [key]: new Set([() => metadata(1, { httpInvocationId: boxed, invocationId: boxed })]) })
  assert.deepEqual(bad, { reason: 'context_invalid' })
  let httpReads = 0, logicalReads = 0
  const changing = { ...metadata(),
    get httpInvocationId() { return ++httpReads === 1 ? id(1) : boxed },
    get invocationId() { return ++logicalReads === 1 ? id(1) : boxed },
  }
  const safe = readContext({ [key]: new Set([() => changing]) })
  assert.equal(safe.value.httpInvocationId, id(1)); assert.equal(safe.value.invocationId, id(1))
  assert.equal(httpReads, 1); assert.equal(logicalReads, 1)
  assert.equal(JSON.stringify([bad, safe]).includes('PRIVATE_'), false)
})

test('diagnostic safety: structure identifiers cannot preserve objects through implicit coercion', () => {
  const f = fixture(); f.collector.checkpoint(0); f.record(1)
  const raw = f.collector.finish(identity, 1)
  raw.statements[1].normalizedStructureId = { toString: () => 'a'.repeat(12), privateCanary: 'PRIVATE_BOXED_SHAPE' }
  const report = projectQueryDiagnostics(raw, { 'startup-bundled': window(0, 1) }, identity)
  assert.equal(report.status, 'unavailable')
  assert.equal(JSON.stringify(report).includes('PRIVATE_'), false)
})

test('diagnostic safety: receipt timestamps accept primitive strings only', () => {
  const strings = [event(1, false), event(1, true)].map(value => ({ ...value, timestamp: ['2026-11-09T00:00:01.000Z'] }))
  const rawAgain = fixture(); rawAgain.collector.checkpoint(0); rawAgain.record(1)
  assert.equal(projectQueryDiagnostics(rawAgain.collector.finish(identity, 1), { 'startup-bundled': window(0, 1) }, identity, lines(strings)).receipts.status, 'incomplete')
})

test('diagnostic safety: Proxy query configs are rejected before any descriptor or value trap runs', () => {
  let traps = 0
  const config = new Proxy({ text: 'SELECT id FROM session WHERE token=$1' }, {
    getOwnPropertyDescriptor(target, property) { traps++; return Object.getOwnPropertyDescriptor(target, property) },
    get(target, property) { traps++; return target[property] },
  })
  const f = fixture(); f.collector.checkpoint(0); f.record(1, config)
  const raw = f.collector.finish(identity, 1)
  assert.equal(traps, 0, 'the diagnostic must not trigger traps before the original driver sees the config')
  assert.ok(raw.queries[0][1] > 0); assert.equal(raw.queries[0][2], 0)
  assert.equal(raw.reasons.statement_proxy, 1)
})

test('diagnostic safety: statement prefixes cannot admit opaque SET payloads or a second statement', () => {
  for (const sql of ['SET application_name = PRIVATE_SETTING', 'SHOW PRIVATE_SETTING', 'SAVEPOINT PRIVATE_NAME',
    'RELEASE PRIVATE_NAME', 'BEGIN PRIVATE_PAYLOAD', 'COMMIT PRIVATE_PAYLOAD', 'ROLLBACK TO PRIVATE_NAME',
    'SELECT 1; SET application_name=PRIVATE_SETTING', 'BEGIN; SET application_name=PRIVATE_SETTING', 'SELECT 1;;']) {
    const shape = statementStructure(sql)
    assert.equal(shape.value, undefined, sql.split(' ')[0]); assert.equal(shape.reason, 'statement_syntax')
    assert.equal(JSON.stringify(shape).includes('PRIVATE_'), false)
  }
  for (const sql of ['BEGIN', 'COMMIT;', 'ROLLBACK ;', 'SELECT id FROM session WHERE token=$1;']) assert.ok(statementStructure(sql).value)
})

test('query capture starts at the existing checkpoint, freezes once and reset creates a new diagnostic history', () => {
  const f = fixture()
  f.record(100); f.collector.checkpoint(100); f.record(101); f.collector.checkpoint(101); f.record(102)
  const first = f.collector.finish(identity, 102)
  assert.equal(first.startQueryCalls, 100); assert.deepEqual(first.queries.map(row => row[0]), [101, 102])
  f.record(103); f.collector.checkpoint(103)
  assert.deepEqual(f.collector.finish(identity, 103), first)
  f.collector.reset(); f.collector.checkpoint(0); f.record(1)
  assert.equal(f.collector.finish({ ...identity, startedAt: 2000 }, 1).startQueryCalls, 0)
})

test('ordinal windows retain carried requests, unknown shapes and all overflow as nonzero unknown costs', () => {
  const f = fixture({ ...LIMITS, queries: 3, contexts: 2, statements: 2 })
  f.collector.checkpoint(100)
  f.record(101)
  f.record(102, "SELECT 'PRIVATE_LITERAL'", metadata(2))
  f.record(103, 'SELECT other FROM session', metadata())
  f.record(104)
  const raw = f.collector.finish(identity, 104)
  assert.equal(raw.queries.length + raw.droppedQueries, 4)
  assert.equal(raw.overflow, true)
  const report = projectQueryDiagnostics(raw, { 'startup-bundled': window(100, 104) }, identity, lines([event(1, false), event(1, true)]))
  const measured = report.windows['startup-bundled']
  assert.equal(measured.expectedQueries, 4); assert.equal(measured.capturedQueries, 3); assert.equal(measured.uncapturedQueries, 1)
  assert.equal(measured.unknownContextQueries, 1); assert.equal(measured.unknownStatementQueries, 2)
  assert.equal(measured.status, 'incomplete'); assert.equal(report.capture.overflow, true)
  assert.equal(JSON.stringify(report).includes('PRIVATE_'), false)
  const middle = projectQueryDiagnostics(raw, { 'startup-bundled': window(101, 103) }, identity, lines([event(1, false), event(1, true)]))
  assert.deepEqual(middle.windows['startup-bundled'].queries.map(row => row[0]), [102, 103])
})

test('query receipts retain exact HTTP method and batch siblings, ignore external IDs and detect mismatches', () => {
  const f = fixture(); f.collector.checkpoint(10)
  f.record(11, 'SELECT 1', metadata(1, { route: '/api/desktop/rpc', method: 'POST' }))
  f.record(12, 'SELECT 1', metadata(1, { invocationId: id(2), route: '/api/desktop/rpc', method: 'POST', rpcAction: 'task-runs.pollTaskRuns' }))
  const raw = f.collector.finish(identity, 12)
  const parent = complete => event(1, complete, { route: '/api/desktop/rpc', method: 'POST', requestId: 'PRIVATE_EXTERNAL_ID', userIdHash: 'PRIVATE_USER',
    ...(complete ? { rpcAction: 'desktop.readBatch', rpcItemCount: 2 } : {}) })
  const child = (n, complete) => event(n, complete, { msg: complete ? 'rpc_action' : 'rpc_action_started',
    httpInvocationId: id(1), route: '/api/desktop/rpc', method: 'POST', rpcAction: n === 2 ? 'task-runs.pollTaskRuns' : 'issues.syncIssueList' })
  const events = [parent(false), parent(true), child(2, false), child(2, true), child(3, false), child(3, true)]
  const report = projectQueryDiagnostics(raw, { 'startup-bundled': window(10, 12) }, identity, lines(events.toReversed()))
  assert.equal(report.receipts.status, 'complete')
  assert.equal(report.receipts.invocations.length, 3, 'the zero-SQL sibling still proves the actual batch action set')
  assert.ok(report.receipts.invocations.every(value => value.method === 'POST'))
  assert.equal(report.contexts[raw.queries[0][1]].rpcAction, null, 'pre-auth physical SQL is never assigned to a later logical child')
  assert.equal(JSON.stringify(report).includes('PRIVATE_'), false)
  for (const changed of [events.slice(1), [...events, child(2, true), { ...child(2, true), status: 500 }],
    [...events, { ...parent(true), rpcAction: 'desktop.bootstrap' }],
    events.map(value => value.invocationId === id(2) ? { ...value, method: 'GET' } : value)]) {
    assert.equal(projectQueryDiagnostics(raw, { 'startup-bundled': window(10, 12) }, identity, lines(changed)).receipts.status, 'incomplete')
  }
  assert.equal(projectQueryDiagnostics(raw, { 'startup-bundled': window(10, 12) }, identity, lines(events.slice(1))).receipts.unpairedInvocations, 1)
})

test('malformed diagnostic payloads, reset identities and absent checkpoints are never manufactured zeroes', () => {
  const f = fixture(); f.collector.checkpoint(10); f.record(11)
  const raw = f.collector.finish(identity, 11)
  for (const value of [{ ...raw, pid: 99 }, { ...raw, queries: [] }, { ...raw, queries: [[12, 1, 1, 1]] },
    { ...raw, queries: [[11, 99, 1, 1]] }, { ...raw, contexts: [{ status: 'unknown' }, { ...metadata(), route: 'PRIVATE_ROUTE' }] },
    { ...raw, reasons: { PRIVATE_REASON: 1 } }, { ...raw, overflow: 'PRIVATE_OVERFLOW' }, { ...raw, overflow: true }]) {
    const result = projectQueryDiagnostics(value, { 'startup-bundled': window(10, 11) }, identity)
    assert.equal(result.status, 'unavailable'); assert.equal(JSON.stringify(result).includes('PRIVATE_'), false)
  }
  const reset = window(10, 11); reset.checkpoints[1].snapshot.startedAt++
  const report = projectQueryDiagnostics(raw, { 'startup-bundled': reset }, identity)
  assert.equal(report.windows['startup-bundled'].status, 'unavailable')
  assert.equal(report.windows['startup-hosted'].status, 'unavailable')
})

test('maximum query/context/structure cardinality stays under the final export bound', () => {
  const f = fixture(); f.collector.checkpoint(0)
  for (let n = 1; n <= LIMITS.queries; n++) f.record(n, `SELECT "column${n % (LIMITS.statements - 1)}" FROM session WHERE id=$1`, metadata(n % (LIMITS.contexts - 1) + 1))
  const raw = f.collector.finish(identity, LIMITS.queries)
  assert.equal(raw.overflow, false)
  assert.ok(Buffer.byteLength(JSON.stringify(raw)) <= LIMITS.bytes)
  assert.equal(raw.queries.length, LIMITS.queries)
})

test('the final projection reads one bounded export after all twelve unchanged snapshots and preserves the original windows', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-query-export-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const revision = 'a'.repeat(40), origin = 'http://localhost:3000', runtimePath = join(directory, 'processes.json')
  const log = join(directory, `bundled-${revision.slice(0, 12)}-44.log`)
  const backend = { ...identity, port: 3000, socket: '/tmp/mikka-bundled-44.sock', log }
  await writeFile(runtimePath, JSON.stringify({ revision, origin, bundled: backend }), { mode: 0o600 })
  // These requests finish outside the counter time ranges. SQL still belongs
  // to its original ordinal window, including inherited background work.
  await writeFile(log, lines([1, 2, 3, 4].flatMap(n => [event(n, false), event(n, true)])), { mode: 0o600 })
  const f = fixture(), paths = [], windows = {}; let sequence = 0, mode = 'normal'
  const dependencies = { httpRequest(options, callback) {
    paths.push(options.path)
    assert.equal(options.socketPath, backend.socket); assert.equal(options.method, 'GET')
    const request = new EventEmitter()
    request.destroy = error => request.emit('error', error)
    request.end = () => queueMicrotask(() => {
      const response = Object.assign(new EventEmitter(), { statusCode: mode === 'http-error' ? 500 : 200, resume() {} })
      let body
      if (options.path === '/metrics') {
        f.collector.checkpoint(sequence)
        body = JSON.stringify({ version: 1, ...identity, measurement: 'all_pg_client_calls_and_connection_protocol_bytes',
          endedAt: 1000 + paths.length, instrumentedClients: 1, queryCalls: sequence,
          pgProtocolReceiveBytes: 0, pgProtocolSendBytes: 0, activeConnections: 1, closedConnections: 0, unknownReadings: 0,
          queryOperations: Object.fromEntries(operations.map(key => [key, key === 'unattributed' ? sequence : 0])),
          unattributedSources: Object.fromEntries(sources.map(key => [key, key === '/api/devices/enrollment' ? sequence : 0])) })
      } else {
        assert.equal(options.path, '/diagnostics'); assert.equal(paths.filter(path => path === '/metrics').length, 12)
        body = mode === 'oversize' ? 'x'.repeat(LIMITS.bytes + 1) : mode === 'invalid' ? '{PRIVATE_INVALID'
          : JSON.stringify(f.collector.finish(identity, sequence))
      }
      callback(response); response.emit('data', Buffer.from(body)); response.emit('end')
    })
    return request
  } }
  const counter = await createLifecycleQueryCounter({ revision, origin, runtimePath }, dependencies)
  const names = {
    nativeLogin: ['before', 'common-email-authentication', 'native-pkce-and-automatic-renderer-to-public-session', 'workspace-selection-to-usable'],
    webLogin: ['before', 'common-email-authentication', 'web-navigation-to-dom-content-loaded', 'workspace-selection-to-usable'],
    'startup-bundled': ['before', 'launch-to-usable'], 'startup-hosted': ['before', 'launch-to-usable'],
  }
  let invocation = 0
  for (const [name, phases] of Object.entries(names)) {
    invocation++
    const checkpoints = []
    for (const [index, phase] of phases.entries()) {
      if (index) f.record(++sequence, 'SELECT id FROM session WHERE token=$1', metadata(invocation))
      checkpoints.push({ phase, snapshot: await counter.snapshot() })
    }
    windows[name] = { status: 'complete', checkpoints,
      total: queryCountDelta(checkpoints[0].snapshot, checkpoints.at(-1).snapshot),
      segments: checkpoints.slice(1).map((point, index) => ({ phase: point.phase, ...queryCountDelta(checkpoints[index].snapshot, point.snapshot) })) }
  }
  const unchanged = structuredClone(windows)
  const result = await counter.rpcActions(windows)
  assert.deepEqual(paths, [...Array(12).fill('/metrics'), '/diagnostics'])
  assert.deepEqual(windows, unchanged)
  assert.equal(result.queryDiagnostics.status, 'complete')
  assert.equal(result.queryDiagnostics.receipts.invocations.length, 4)
  assert.equal(result.queryDiagnostics.windows.nativeLogin.expectedQueries, 3)
  assert.equal(Object.values(result.queryDiagnostics.windows).reduce((sum, value) => sum + value.capturedQueries, 0), sequence)
  // The original RPC result is identical when using its historical aggregate
  // boundaries. That legacy projection must not acquire new query evidence.
  const historical = Object.fromEntries(Object.entries(windows).map(([name, { checkpoints: _points, ...value }]) => [name, value]))
  const { queryDiagnostics: _diagnostics, ...original } = result
  assert.deepEqual(await counter.rpcActions(historical), original)
  assert.equal(paths.length, 13)
  for (mode of ['oversize', 'invalid', 'http-error']) {
    const failed = await counter.rpcActions(windows)
    assert.deepEqual(failed.queryDiagnostics, { version: 1, status: 'unavailable', reasons: ['diagnostic_read_failed'] })
    assert.equal(JSON.stringify(failed).includes('PRIVATE_'), false)
  }
  assert.equal(paths.filter(path => path === '/metrics').length, 12, 'export failures never add a counter snapshot or retry')
})

test('actual request ALS and manageDatabasePool bind concurrent and reused queued clients without a global current request', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'mikka-query-context-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const script = join(temporary, 'probe.mjs')
  const root = fileURLToPath(new URL('../../../', import.meta.url))
  const require = createRequire(new URL('../../../package.json', import.meta.url))
  await writeFile(script, `
    import assert from 'node:assert/strict'; import {EventEmitter} from 'node:events'; import {AsyncLocalStorage} from 'node:async_hooks';
    import {createRequire} from 'node:module'; import {pathToFileURL} from 'node:url'; import {join} from 'node:path';
    const root=process.argv[2], require=createRequire(join(root,'package.json'));
    const diagnostic=require(join(root,'apps/desktop/test/db-query-diagnostics.cjs'));
    const log=await import(pathToFileURL(join(root,'lib/request-log.ts')).href);
    const {manageDatabasePool}=await import(pathToFileURL(join(root,'lib/db/pool-lifecycle.ts')).href);
    const {statementId}=await import(pathToFileURL(join(root,'lib/tracing/sanitize.ts')).href);
    assert.equal(diagnostic.statementStructure('SELECT id FROM session WHERE token=$1').value.normalizedStructureId,statementId('SELECT id FROM session WHERE token=$1'));
    assert.ok(globalThis[Symbol.for('mikka.requestDiagnosticReaders')] instanceof Set,'actual request-log must register its own safe ALS getter');
    const {Pool}=require('pg'); let clients=0,sequence=0; const observed=[]; const logs=[];
    const collector=diagnostic.createQueryDiagnostics(); collector.checkpoint(0);
    const route=globalThis[Symbol.for('mikka.requestRoute')];
    class Client extends EventEmitter {
      _queryable=true; _ending=false;
      constructor(){super();clients++} connect(callback){queueMicrotask(callback)} end(callback){callback?.();this.emit('end')}
      query(text,values,callback){const cb=typeof values==='function'?values:callback; observed.push(diagnostic.readContext());
        collector.record(++sequence,text,route.getStore()); queueMicrotask(()=>cb(null,{rows:[]}));}
    }
    const pool=manageDatabasePool(new Pool({max:1,idleTimeoutMillis:0,Client})); const held=await pool.connect();
    const sink=line=>logs.push(JSON.parse(line));
    const native=log.withRequestLog('/api/desktop/rpc',async()=>{
      log.noteLogRpcAction('desktop.readBatch');
      await Promise.all(['task-runs.pollTaskRuns','issues.syncIssueList'].map(action=>log.withRpcActionLog(action,async()=>{
        await Promise.resolve(); await pool.query('SELECT id FROM session WHERE token=$1',['PRIVATE_PARAMETER']);
      }))); return new Response(null);
    },sink)(new Request('http://localhost/mikka/api/desktop/rpc',{method:'POST',headers:{'x-vercel-id':'PRIVATE_EXTERNAL_ID',cookie:'PRIVATE_COOKIE'}}));
    const enrollment=log.withRequestLog('/api/devices/enrollment',async()=>{await Promise.resolve();await pool.query('SELECT id FROM session WHERE token=$1',['PRIVATE_PARAMETER']);return new Response(null)},sink)(new Request('http://localhost/mikka/api/devices/enrollment'));
    await Promise.resolve(); await Promise.resolve();
    assert.equal(pool.waitingCount,3,'all three actual Pool.query callbacks must wait for the same held client');
    await log.withRequestLog('/api/workspace',async()=>{held.release();return new Response(null)},sink)(new Request('http://localhost/mikka/api/workspace'));
    await Promise.all([native,enrollment]);
    assert.deepEqual(observed.map(value=>value.value?.rpcAction),['task-runs.pollTaskRuns','issues.syncIssueList',null]);
    assert.deepEqual(observed.map(value=>value.value?.method),['POST','POST','GET']);
    const parent=observed[0].value.httpInvocationId; assert.equal(observed[1].value.httpInvocationId,parent);
    assert.notEqual(observed[0].value.invocationId,observed[1].value.invocationId);
    await log.withRequestLog('/api/devices/enrollment',async()=>{await pool.query('SELECT 1');return new Response(null)},sink)(new Request('http://localhost/mikka/api/devices/enrollment',{method:'POST'}));
    assert.equal(clients,1); assert.equal(observed.at(-1).value.method,'POST'); assert.notEqual(observed.at(-1).value.httpInvocationId,parent);
    let deferred; await log.withRequestLog('/api/workspace',async()=>{deferred=AsyncLocalStorage.bind(()=>diagnostic.readContext());return new Response(null)},sink)(new Request('http://localhost/mikka/api/workspace'));
    assert.equal(diagnostic.readContext().reason,'context_missing'); assert.equal(deferred().value.route,'/api/workspace');
    const second=await import(pathToFileURL(join(root,'lib/request-log.ts')).href+'?diagnostic-second-copy');
    assert.equal(globalThis[Symbol.for('mikka.requestDiagnosticReaders')].size,2);
    await log.withRequestLog('/api/workspace',()=>second.withRequestLog('/api/workspace',async()=>{assert.equal(diagnostic.readContext().reason,'context_ambiguous');return new Response(null)},sink)(new Request('http://localhost/mikka/api/workspace')),sink)(new Request('http://localhost/mikka/api/workspace'));
    await second.withRequestLog('/api/workspace',async()=>{assert.equal(diagnostic.readContext().value.route,'/api/workspace');return new Response(null)},sink)(new Request('http://localhost/mikka/api/workspace'));
    const raw=collector.finish({pid:77,runtime:'nitro',startedAt:1000},sequence);
    const window={status:'complete',checkpoints:[{phase:'before',snapshot:{pid:77,runtime:'nitro',startedAt:1000,queryCalls:0}},{phase:'launch-to-usable',snapshot:{pid:77,runtime:'nitro',startedAt:1000,queryCalls:sequence}}]};
    const report=diagnostic.projectQueryDiagnostics(raw,{'startup-bundled':window},{pid:77,runtime:'nitro'},logs.map(value=>JSON.stringify(value)).join('\\n'));
    assert.equal(report.receipts.status,'complete'); assert.equal(report.windows['startup-bundled'].status,'complete');
    assert.equal(JSON.stringify(raw).includes('PRIVATE_'),false); assert.equal(JSON.stringify(report).includes('PRIVATE_'),false);
    await pool.end(); console.log(JSON.stringify({queries:sequence,clients,queued:3,moduleCopies:2,receiptStatus:report.receipts.status}));
  `)
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', require.resolve('tsx'), script, root], {
    cwd: root, env: { PATH: process.env.PATH }, timeout: 20_000, maxBuffer: 32_768,
  })
  assert.deepEqual(JSON.parse(stdout), { queries: 4, clients: 1, queued: 3, moduleCopies: 2, receiptStatus: 'complete' })
})
