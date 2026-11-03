import assert from 'node:assert/strict'
import test from 'node:test'
import type { PoolClient } from 'pg'
import { describeSample, SAMPLE_RATE, sampleClient, withDatabaseOperation } from './egress-sample'
import { withRequestLog } from '../request-log'

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

test('the gate is off without PostHog', async () => {
  const { deploymentSwitch } = await import('../deployment-switches')
  assert.equal(deploymentSwitch('dbEgressSample', {}), false)
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
