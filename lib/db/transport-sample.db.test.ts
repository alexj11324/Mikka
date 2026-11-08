import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import test from 'node:test'
import { Pool, type PoolClient } from 'pg'
import { sampleClient } from './egress-sample'
import { manageDatabasePool } from './pool-lifecycle'
import { PgReceiveCollector } from './transport-sample'
import { routeScope } from '../tracing/labels'
import { assertE2eTarget } from '../../tests/helpers/e2e-target.mjs'

const connectionString = process.env.MIKKA_TRANSPORT_TEST_DATABASE_URL ?? process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !connectionString) throw new Error('Isolated transport test database is required')

test('isolated Postgres: queued requests preserve attribution with no additional SQL, including an unscoped caller and error', { skip: !connectionString }, async () => {
  const target = assertE2eTarget(connectionString!)
  assert.ok(['localhost', '127.0.0.1'].includes(target.hostname))
  assert.match(target.pathname, /^\/mikka_(transport_)?e2e$/)
  const pool = manageDatabasePool(new Pool({ connectionString, max: 1 }))
  const caller = new AsyncLocalStorage<string>()
  const calls: { route: string | undefined; caller: string | undefined }[] = []
  const lines: string[] = []
  pool.on('connect', client => {
    sampleClient(client, () => true, () => 0, line => lines.push(line))
    const query = client.query.bind(client) as (...args: unknown[]) => unknown
    ;(client as { query: unknown }).query = (...args: unknown[]) => {
      calls.push({ route: routeScope.getStore(), caller: caller.getStore() })
      return query(...args)
    }
  })
  let held: PoolClient | undefined, released = false
  const pending: Promise<unknown>[] = []
  try {
    held = await pool.connect()
    const read = (marker: number) => pool.query('select current_database() as database, $1::integer as marker', [marker])
    const first = caller.run('first', () => routeScope.run('/api/agent/sessions', () => read(1)))
    const second = caller.run('second', () => routeScope.run('/actions/issues/poll', () => read(2)))
    const background = caller.exit(() => routeScope.exit(() => read(3)))
    const failure = caller.run('failed', () => routeScope.run('/api/settings/preferences', () =>
      assert.rejects(pool.query('select definitely_not_a_real_function()'), { code: '42883' })))
    pending.push(first, second, background, failure)
    assert.equal(pool.waitingCount, 4)
    caller.run('foreign-release', () => routeScope.run('/api/unrelated', () => held!.release()))
    released = true
    const values = await Promise.all([first, second, background])
    await failure
    assert.deepEqual(values.map(value => value.rows), [1, 2, 3].map(marker => [{ database: target.pathname.slice(1), marker }]))
    assert.deepEqual(calls, [
      { route: '/api/agent/sessions', caller: 'first' },
      { route: '/actions/issues/poll', caller: 'second' },
      { route: undefined, caller: undefined },
      { route: '/api/settings/preferences', caller: 'failed' },
    ], 'exactly the four requested queries retain their scope; no setup SQL, replay or retry')
    assert.deepEqual(lines.map(line => JSON.parse(line).route), ['/api/agent/sessions', '/actions/issues/poll', null])
    assert.equal(pool.waitingCount, 0)
  } finally {
    if (held && !released) held.release()
    await Promise.allSettled(pending)
    await pool.end()
  }
})

test('isolated Postgres: queued queries and two clients equal socket counter deltas, including errors', { skip: !connectionString }, async () => {
  const target = assertE2eTarget(connectionString!)
  assert.ok(['localhost', '127.0.0.1'].includes(target.hostname))
  assert.match(target.pathname, /^\/mikka_(transport_)?e2e$/)
  const pool = new Pool({ connectionString, max: 1 }), workspace = new Pool({ connectionString, max: 1 })
  const lines: string[] = []; let tick: (() => void) | undefined; let now = 1_000
  const collector = new PgReceiveCollector({ on: () => true, now: () => now, sink: line => lines.push(line), schedule: callback => { tick = callback; return () => { tick = undefined } } })
  collector.watch(pool, 'request')
  collector.watch(workspace, 'workspace')
  const one = await pool.connect(), two = await workspace.connect()
  const stream = (client: unknown) => (client as { connection: { stream: { bytesRead: number } } }).connection.stream
  const startOne = stream(one).bytesRead, startTwo = stream(two).bytesRead
  let jsonBytes = 0
  try {
    assert.equal((await one.query('select current_database() name')).rows[0].name, target.pathname.slice(1))
    const wide = `select ${Array.from({ length: 22 }, (_, i) => `${i} as "synthetic_column_${i}"`).join(',')} where false`
    const queries = Array.from({ length: 40 }, (_, i) => i % 2 ? wide : 'select true as ok')
    await Promise.all(queries.flatMap(sql => [one, two].map(async client => { const result = await client.query(sql); jsonBytes += Buffer.byteLength(JSON.stringify(result.rows)) })))
    // pg rejects at ErrorResponse before the trailing ReadyForQuery may arrive.
    const errorReady = new Promise<void>(resolve => (one as unknown as { connection: { once: (event: string, callback: () => void) => unknown } }).connection.once('readyForQuery', resolve))
    await assert.rejects(one.query('select definitely_not_a_real_function()'))
    await errorReady
    const expected = stream(one).bytesRead - startOne + stream(two).bytesRead - startTwo
    now += 60_000; tick!()
    const observed = JSON.parse(lines[0])
    assert.equal(observed.pgProtocolReceiveBytes, expected)
    assert.equal(observed.connections, 2)
    assert.deepEqual(observed.scopes, ['request', 'workspace'])
    assert.equal(observed.unknownReadings, 0)
    assert.ok(expected > jsonBytes * 5, 'wide empty row-description results expose protocol bytes absent from row JSON')
    const removed = new Promise<void>(resolve => { let count = 0; for (const source of [pool, workspace]) source.on('remove', () => { if (++count === 2) resolve() }) })
    one.release(true); two.release(true)
    await removed; await Promise.all([pool.end(), workspace.end()])
    assert.equal(lines.reduce((sum, line) => sum + JSON.parse(line).pgProtocolReceiveBytes, 0), expected)
    assert.equal(tick, undefined)
    console.log(JSON.stringify({ experiment: 'isolated_80_synthetic_queries_plus_identity_and_one_error', pgProtocolReceiveBytes: expected, rowsJsonBytes: jsonBytes, connections: 2, startupExcluded: true, supplierBytes: 'not_measured' }))
  } finally {
    // Ensure failed assertions also release this isolated test pool.
    if (!pool.ending) { one.release(true); await pool.end() }
    if (!workspace.ending) { two.release(true); await workspace.end() }
  }
})

test('isolated workspace-db runtime registers its actual pool with workspace coverage', { skip: !connectionString }, async () => {
  assertE2eTarget(connectionString!)
  const previous = process.env.DATABASE_URL, log = console.log
  const { overrideDeploymentSwitch } = await import('../deployment-switches')
  const lines: string[] = []
  process.env.DATABASE_URL = connectionString
  overrideDeploymentSwitch('dbEgressSample', true)
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes('"msg":"db_transport_sample"')) lines.push(args[0])
    else log(...args)
  }
  let workspace: Pool | undefined, client: PoolClient | undefined
  let released = false
  try {
    workspace = (await import('../workspace-db')).workspacePool
    client = await workspace.connect()
    const removed = new Promise<void>(resolve => workspace!.once('remove', () => resolve()))
    await client.query('select true as synthetic_workspace_observation')
    client.release(true); released = true
    await removed
    await workspace.end()
    assert.equal(lines.length, 1)
    const sample = JSON.parse(lines[0])
    assert.deepEqual(sample.scopes, ['workspace'])
    assert.ok(sample.pgProtocolReceiveBytes > 0)
    assert.equal(sample.unknownReadings, 0)
  } finally {
    console.log = log
    overrideDeploymentSwitch('dbEgressSample', undefined)
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
    if (client && !released) client.release(true)
    if (workspace && !workspace.ending) await workspace.end()
  }
})
