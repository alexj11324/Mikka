import '../../scripts/credential-diagnostics-offline.mjs'
import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { Pool, type PoolClient } from 'pg'
import { describeSample, LARGE_RESULT_BYTES, SAMPLE_RATE, sampleClient, withDatabaseOperation } from './egress-sample'
import { manageDatabasePool } from './pool-lifecycle'
import { withRequestLog } from '../request-log'
import { routeScope } from '../tracing/labels'

const result = { command: 'SELECT', rowCount: 2, rows: [{ id: 'a', text: 'PRIVATE_TEXT' }, { id: 'b', text: 'x' }], fields: [], oid: 0 }
function fakeClient() {
  return {
    query(...args: unknown[]) {
      const callback = args.at(-1)
      if (typeof callback === 'function') { queueMicrotask(() => callback(null, result)); return undefined }
      return Promise.resolve(result)
    },
  } as unknown as PoolClient
}

test('a sampled query logs its tables, rows and bytes, never its parameters or row content', async () => {
  const lines: string[] = []
  const client = fakeClient()
  sampleClient(client, () => true, () => 0, line => lines.push(line))
  const sqlText = 'select "id", "text" from "coordinator_messages" join bots b on b.id = $1 where "userId" = $2'
  await client.query(sqlText, ['PRIVATE_PARAM', 'PRIVATE_USER'])
  await new Promise<void>(resolve => (client.query as (...args: unknown[]) => void)({ text: 'update agent_runs set x = $1', values: ['PRIVATE_PARAM'] }, () => resolve()))
  assert.equal(lines.length, 2, 'promise and callback (Pool.query) forms are both sampled')
  const [first, second] = lines.map(line => JSON.parse(line))
  assert.ok(Number.isFinite(Date.parse(first.timestamp)))
  assert.deepEqual({ ...first, statement: undefined, timestamp: undefined }, { level: 'info', msg: 'db_sample', timestamp: undefined, sampleRate: SAMPLE_RATE, route: null, command: 'SELECT', tables: ['coordinator_messages', 'bots'], statement: undefined, rows: 2, bytes: Buffer.byteLength(JSON.stringify(result.rows)) })
  assert.match(first.statement, /^[0-9a-f]{12}$/)
  assert.deepEqual(second.tables, ['agent_runs'])
  assert.ok(!lines.join('\n').includes('PRIVATE'), 'no values reach the log')
})

test('unsampled queries and a gate that is off pass straight through', async () => {
  const lines: string[] = []
  const unsampled = fakeClient()
  sampleClient(unsampled, () => true, () => SAMPLE_RATE, line => lines.push(line))
  assert.equal(await unsampled.query('select 1'), result)
  const off = fakeClient()
  sampleClient(off, () => false, () => 0, line => lines.push(line))
  assert.equal(await off.query('select 1'), result)
  assert.equal(lines.length, 0)
  assert.equal(describeSample('BEGIN', { command: 'BEGIN', rows: [] } as never, 'r').bytes, 0)
})

test('community diagnostics use the deployed default and retain an explicit local switch', async () => {
  const { deploymentSwitch } = await import('../deployment-switches')
  assert.equal(deploymentSwitch('dbEgressSample', {}), true)
  assert.equal(deploymentSwitch('dbEgressSample', { MIKKA_DB_EGRESS_SAMPLE: '0' }), false)
  assert.equal(deploymentSwitch('dbEgressSample', { MIKKA_EDITION: 'cloud' }), false)
})

test('large reads outside the random sample are recorded exactly once with their actual inclusion rate', async () => {
  const lines: string[] = []
  const large = { ...result, rows: [{ text: 'PRIVATE_TEXT'.repeat(LARGE_RESULT_BYTES) }] }
  const client = { query: () => Promise.resolve(large) } as unknown as PoolClient
  sampleClient(client, () => true, () => 0.9, line => lines.push(line))
  assert.equal(await client.query('select payload from run_chunks'), large)
  assert.equal(lines.length, 1)
  const sample = JSON.parse(lines[0])
  assert.equal(sample.sampleRate, 1)
  assert.equal(sample.bytes, Buffer.byteLength(JSON.stringify(large.rows)))
  assert.ok(!lines[0].includes('PRIVATE'))

  const selected = { query: () => Promise.resolve(large) } as unknown as PoolClient
  sampleClient(selected, () => true, () => 0, line => lines.push(line))
  await selected.query('select payload from run_chunks')
  assert.equal(lines.length, 2, 'large reads selected randomly are not counted twice')
  assert.equal(JSON.parse(lines[1]).sampleRate, 1)
})

test('a sampled query names the logged route it ran under', async () => {
  const lines: string[] = []
  const client = fakeClient()
  sampleClient(client, () => true, () => 0, line => lines.push(line))
  await withRequestLog('/v1/devices/[deviceId]/commands', async () => { await client.query('select id from agent_runs'); return new Response(null) }, () => {})(new Request('https://x.test/'))
  assert.equal(JSON.parse(lines[0]).route, '/v1/devices/[deviceId]/commands')
})

test('concurrent Server Actions keep fixed attribution separate across async queries', async () => {
  const lines: string[] = [], client = fakeClient()
  sampleClient(client, () => true, () => 0, line => lines.push(line))
  await Promise.all(['/actions/issues/poll', '/actions/coordinator/poll'].map(operation => withDatabaseOperation(operation, async () => {
    await Promise.resolve()
    await client.query('select id from coordinator_messages')
  })))
  assert.deepEqual(lines.map(line => JSON.parse(line).route).sort(), ['/actions/coordinator/poll', '/actions/issues/poll'])
})

test('queued Pool.query retains its initiating route and request scope, including unscoped work', async t => {
  const lines: string[] = [], owners: (string | undefined)[] = []
  const owner = new AsyncLocalStorage<string>()
  let finishFirst: () => void = () => assert.fail('first query did not start')
  let enteredFirst: () => void = () => {}
  const firstStarted = new Promise<void>(resolve => { enteredFirst = resolve })
  let statements = 0
  // Use the installed pg.Pool's real queue and release path. Only the transport
  // is controlled: the first connection stays busy until both other callers
  // are queued, then its completion arrives under that first request's scope.
  class Client extends EventEmitter {
    _queryable = true
    _ending = false
    connect(callback: () => void) { queueMicrotask(callback) }
    end(callback?: () => void) { callback?.() }
    query(_text: string, _values: unknown, callback: (error: null, value: typeof result) => void) {
      statements++
      owners.push(owner.getStore())
      if (statements === 1) {
        finishFirst = () => callback(null, result)
        enteredFirst()
      } else queueMicrotask(() => callback(null, result))
    }
  }
  const pool = manageDatabasePool(new Pool({ max: 1, Client: Client as never }))
  t.after(() => pool.end())
  pool.on('connect', client => sampleClient(client, () => true, () => 0, line => lines.push(line)))
  const first = owner.run('first-owner', () => routeScope.run('/api/agent/sessions', () => pool.query('select id from agent_sessions')))
  await firstStarted
  const second = owner.run('second-owner', () => routeScope.run('/actions/issues/poll', () => pool.query('select id from issues')))
  const background = owner.exit(() => routeScope.exit(() => pool.query('select id from device_tokens')))
  assert.equal(pool.waitingCount, 2, 'the regression must exercise queued acquisition, not idle clients')
  owner.run('first-owner', () => routeScope.run('/api/agent/sessions', finishFirst))
  assert.deepEqual(await Promise.all([first, second, background]), [result, result, result])
  assert.equal(statements, 3, 'context propagation adds no statement or retry')
  assert.equal(pool.waitingCount, 0)
  assert.deepEqual(owners, ['first-owner', 'second-owner', undefined])
  assert.deepEqual(lines.map(line => JSON.parse(line).route), ['/api/agent/sessions', '/actions/issues/poll', null])
  assert.ok(!lines.join('\n').includes('owner'))
})
