// Actual locked drivers, with no sockets, server, SQL submission or cleanup.
import './credential-diagnostics-offline.mjs'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import pg, * as esm from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { pgTable, integer, text, jsonb, date, timestamp } from 'drizzle-orm/pg-core'
import { scopeNativeRuntime, SCOPE_IDENTITY_SQL } from './scope-acceptance-runtime.mjs'
import { scopeUrl, SCOPE_DATABASES } from './scope-acceptance-policy.mjs'

const require = createRequire(import.meta.url)
const url = scopeUrl(SCOPE_DATABASES.scope)
const fields = (names, ids) => names.map((name, i) => ({ name, dataTypeID: ids[i], format: 'text' }))
const nativeQuery = pg.Client.prototype.query
let submissions = 0

// Only the terminal transport is replaced. Query/Result/type overrides,
// Pool/Client constructors, queueing, release, hooks and error paths are real.
class TerminalClient extends pg.Client {
  _connect(callback) { this._connecting = true;this._connectionCallback = callback;queueMicrotask(() => this._handleReadyForQuery({ status: 'I' })) }
  query(...args) {
    this.readyForQuery = false
    this.connection.query = () => { submissions++;throw Error('offline SQL submission prohibited') }
    const returned = nativeQuery.apply(this, args)
    const query = this._queryQueue.pop()
    queueMicrotask(() => {
      if (query.text === 'offline-error') return query.handleError(Object.assign(Error('terminal error'), { code: 'OFFLINE_ERROR' }), this.connection)
      const identity = query.text === SCOPE_IDENTITY_SQL
      const names = identity ? ['database','role','oid'] : ['value']
      query.handleRowDescription({ fields: fields(names, names.map(() => pg.types.builtins.TEXT)) })
      query.handleDataRow({ fields: (identity ? [this.database,this.user,'65537'] : ['terminal value']) })
      query.handleCommandComplete({ text: 'SELECT 1' }, this.connection)
      query.handleReadyForQuery(this.connection)
    })
    return returned
  }
  end(callback) { this._ending = true;this._ended = true;this.emit('end');if (callback) { queueMicrotask(callback);return }return Promise.resolve() }
}
function runtime({ rejectQueryResult = false } = {}) {
  let sequence = 0
  const events = []
  return { events, native: scopeNativeRuntime(pg, async (kind, input) => {
    events.push({ kind, input })
    if (rejectQueryResult && kind === 'query-result' && !input.identity) throw Error('offline result acknowledgement lost')
    if (kind === 'query' || kind === 'cleanup') return { id: String(++sequence) }
  }, 'scope', 'suite') }
}

test('real pg CJS/ESM exports, constructors, defaults, descriptors and symbols remain identical', { timeout: 10000 }, async () => {
  const cjs = require('pg'), descriptors = Object.getOwnPropertyDescriptors(pg)
  const clientSymbols = Object.getOwnPropertySymbols(pg.Client.prototype)
  const poolSymbols = Object.getOwnPropertySymbols(pg.Pool.prototype)
  const { native } = runtime()
  try {
    assert.equal(esm.default, cjs)
    for (const [name, value] of Object.entries(esm)) if (name !== 'default') assert.equal(value, pg[name], name)
    assert.deepEqual(Object.getOwnPropertyDescriptors(pg), descriptors)
    assert.deepEqual(Object.getOwnPropertySymbols(pg.Client.prototype), clientSymbols)
    assert.deepEqual(Object.getOwnPropertySymbols(pg.Pool.prototype), poolSymbols)
    assert.equal(native.Pool, pg.Pool);assert.equal(native.Client, pg.Client)
    const pool = new pg.Pool({ connectionString: url })
    const client = new pg.Client({ connectionString: url })
    assert.equal(pool.Client, pg.Client);assert.equal(client.constructor, pg.Client)
    assert.equal(pg.Client.Query, pg.Query)
    assert.throws(() => client.query('offline-before-connect'), /before approved connection/)
    assert.equal(pg.types.getTypeParser(pg.types.builtins.INT4)('42'), 42)
    await pool.end();await client.end()
  } finally { await native.close() }
})

test('actual Drizzle prepared-query parsers use real pg.Result without connecting or submitting SQL', { timeout: 10000 }, async () => {
  const table = pgTable('offline_shape', {
    id: integer(), label: text(), payload: jsonb(), day: date(), at: timestamp({ withTimezone: true, mode: 'string' }),
  })
  const pool = new pg.Pool({ connectionString: url })
  try {
    const prepared = drizzle(pool).select().from(table).prepare('offline-shape')
    assert.equal(prepared.queryConfig.name, 'offline-shape')
    assert.equal(prepared.queryConfig.rowMode, 'array')
    assert.match(prepared.queryConfig.text, /select/)
    for (const config of [prepared.queryConfig, prepared.rawQueryConfig]) {
      const result = new pg.Result(config.rowMode, config.types)
      result.addFields(fields(['id','label','payload','day','at'], [23,25,3802,1082,1184]))
      const parsed = result.parseRow(['42',null,'{"synthetic":true}','2026-10-28','2026-10-28 00:00:00+00'])
      const values = Array.isArray(parsed) ? parsed : Object.values(parsed)
      assert.equal(values[0], 42);assert.equal(values[1], null)
      assert.deepEqual(values[2], { synthetic: true })
      assert.equal(typeof values[3], 'string');assert.equal(typeof values[4], 'string')
    }
    assert.equal(pg.utils.prepareValue({ synthetic: true }), '{"synthetic":true}')
    assert.equal(pg.utils.prepareValue(new Date('2026-10-28T00:00:00Z')).startsWith('2026-10-28'), true)
  } finally { await pool.end() }
})

test('real pool promise/callback checkout, release, double-release, hooks and error removal retain driver behavior', { timeout: 10000 }, async () => {
  const { native, events } = runtime()
  class CustomPromise extends Promise {}
  const hookClients = []
  const pool = new pg.Pool({ connectionString: url, Client: TerminalClient, Promise: CustomPromise, max: 1, onConnect: client => hookClients.push(client) })
  try {
    const pending = pool.connect();assert.ok(pending instanceof CustomPromise)
    const first = await pending
    assert.ok(first instanceof pg.Client);assert.equal(first, hookClients[0])
    assert.equal(first.getStartupConf().statement_timeout, '20000')
    assert.equal(first.getStartupConf().lock_timeout, '10000')
    assert.equal(first._connectionTimeoutMillis, 3000)
    assert.equal(first.connectionParameters.query_timeout, 22000)
    const value = await first.query({ text: 'offline-value', rowMode: 'array' })
    assert.deepEqual(value.rows, [['terminal value']])
    await new Promise((resolve, reject) => {
      assert.equal(first.query({ text: 'offline-value', callback: (error, result) => error ? reject(error) : resolve(result) }), undefined)
    })
    const submitted = new pg.Query({ text: 'offline-value', rowMode: 'array' })
    await new Promise((resolve, reject) => {
      submitted.once('error', reject);submitted.once('end', result => { assert.deepEqual(result.rows, [['terminal value']]);resolve() })
      assert.equal(first.query(submitted), submitted)
    })
    const callbackOrder = []
    await new Promise((resolve, reject) => {
      const query = new pg.Query({ text: 'offline-value', callback: error => { if (error) return reject(error);callbackOrder.push('callback') } })
      query.once('end', () => { callbackOrder.push('end');resolve() })
      assert.equal(first.query(query), query)
    })
    assert.deepEqual(callbackOrder, ['callback','end'])
    await new Promise(resolve => {
      const query = new pg.Query('offline-error')
      query.once('error', error => { assert.equal(error.code, 'OFFLINE_ERROR');resolve() })
      assert.equal(first.query(query), query)
    })
    const typed = await first.query({ text: 'offline-value', types: { getTypeParser: () => value => value.toUpperCase() } })
    assert.equal(typed.rows[0].value, 'TERMINAL VALUE')
    await assert.rejects(first.query('offline-error'), error => error.code === 'OFFLINE_ERROR')
    first.release();assert.throws(() => first.release(), /already been released/)
    await new Promise((resolve, reject) => pool.connect((error, client, release) => {
      if (error) return reject(error)
      assert.equal(client, first);assert.equal(release, client.release)
      release(Error('synthetic eviction'));resolve()
    }))
    assert.equal(pool.totalCount, 0)
    assert.ok(events.some(event => event.kind === 'query-result' && event.input.code === 'OFFLINE_ERROR'))
    assert.equal(submissions, 0)
  } finally { await native.close() }
})

test('real client connect result, pool verification failure and denied target never submit SQL or reach a socket', { timeout: 10000 }, async () => {
  const { native } = runtime()
  const direct = new TerminalClient({ connectionString: url })
  const denied = new pg.Pool({ connectionString: scopeUrl('unapproved_database') })
  const failed = new pg.Pool({ connectionString: url, Client: TerminalClient, verify: (_client, callback) => callback(Error('offline verify failure')) })
  try {
    assert.equal(await direct.connect(), direct)
    const callbackClient = new TerminalClient({ connectionString: url })
    await new Promise((resolve, reject) => callbackClient.connect(function (error, value) {
      if (error) return reject(error)
      assert.equal(arguments.length, 2);assert.equal(value, callbackClient);resolve()
    }))
    assert.deepEqual((await direct.query('offline-value')).rows, [{ value: 'terminal value' }])
    await assert.rejects(denied.connect(), /mismatch/)
    await new Promise(resolve => failed.connect((error, client, release) => {
      assert.match(error.message, /verify failure/);assert.equal(client, undefined);assert.equal(typeof release, 'function');release();resolve()
    }))
    assert.equal(failed.totalCount, 0);assert.equal(submissions, 0)
  } finally { await native.close();await denied.end() }
})

test('real pg.Query result-acknowledgement loss reaches callback/error once and never emits successful end', { timeout: 10000 }, async () => {
  const { native } = runtime({ rejectQueryResult: true })
  const pool = new pg.Pool({ connectionString: url, Client: TerminalClient })
  try {
    const client = await pool.connect()
    for (const withCallback of [false, true]) {
      let ends = 0, errors = 0
      await new Promise((resolve, reject) => {
        const onError = error => { errors++;assert.match(error.message, /acknowledgement lost/);queueMicrotask(resolve) }
        const query = new pg.Query({ text: 'offline-value', ...(withCallback ? { callback: onError } : {}) })
        query.on('end', () => { ends++;reject(Error('false successful end after lost result acknowledgement')) })
        query.on('error', withCallback ? reject : onError)
        assert.equal(client.query(query), query)
      })
      assert.equal(ends, 0);assert.equal(errors, 1)
    }
    client.release()
    assert.equal(submissions, 0)
  } finally { await native.close() }
})

test('actual frozen SQL directory and sync/async reads include all pinned migrations before any connection',{timeout:25000},async()=>{
  const output=await promisify(execFile)(process.execPath,['--import','./scripts/credential-diagnostics-offline.mjs','--import','./scripts/server-test.mjs','--import','tsx','scripts/scope-native-offline-startup.mjs','migration-cache'],{timeout:20000,maxBuffer:1<<20,env:{PATH:process.env.PATH,HOME:'/workspace',TSX_DISABLE_CACHE:'1',NODE_DISABLE_COMPILE_CACHE:'1',MIGRATE:'0',VERCEL_ENV:'',NEXT_TELEMETRY_DISABLED:'1'}})
  assert.match(output.stdout,/"frozenMigrationCache":true,"pinnedSqlEntries":73,"syntheticCacheOnlyEntry":true,"nativeTransportAttempts":0,"nativeSqlSubmissions":0/)
})

for (const phase of ['scope','team','team-resume']) test(`actual ${phase} suite startup and installed loader stop at the first connection boundary, offline`, { timeout: 25000 }, async () => {
  let failure
  try {
    await promisify(execFile)(process.execPath, ['--import','./scripts/credential-diagnostics-offline.mjs','--import','./scripts/server-test.mjs','--import','tsx','scripts/scope-native-offline-startup.mjs',phase], {
      timeout: 20000, maxBuffer: 1 << 20,
      env: { PATH: process.env.PATH, HOME: '/workspace', TSX_DISABLE_CACHE: '1', NODE_DISABLE_COMPILE_CACHE: '1', NEXT_TELEMETRY_DISABLED: '1', NODE_ENV: 'development', ISSUE184_LOCAL_TEST: '1', REQUIRE_DB: '1', MIGRATE: '0', VERCEL_ENV: '', BETTER_AUTH_URL: 'http://127.0.0.1:3100' },
    })
  } catch (error) { failure = error }
  assert.equal(failure?.code, 1, 'the real suite deliberately fails at its first connection gate')
  assert.match(failure.stdout, /OFFLINE_FIRST_CONNECTION_BOUNDARY/)
  assert.match(failure.stdout, /"nativeTransportAttempts":0,"nativeSqlSubmissions":0/)
  assert.doesNotMatch(failure.stdout, /reading 'builtins'|scope filesystem cleanup denied/)
})
