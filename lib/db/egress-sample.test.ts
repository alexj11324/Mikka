import assert from 'node:assert/strict'
import test from 'node:test'
import type { PoolClient } from 'pg'
import { describeSample, sampleClient, sampleRate } from './egress-sample'

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
  sampleClient(client, 1, () => 0, line => lines.push(line))
  const sqlText = 'select "id", "text" from "coordinator_messages" join bots b on b.id = $1 where "userId" = $2'
  await client.query(sqlText, ['PRIVATE_PARAM', 'PRIVATE_USER'])
  await new Promise<void>(resolve => (client.query as (...args: unknown[]) => void)({ text: 'update agent_runs set x = $1', values: ['PRIVATE_PARAM'] }, () => resolve()))
  assert.equal(lines.length, 2, 'promise and callback (Pool.query) forms are both sampled')
  const [first, second] = lines.map(line => JSON.parse(line))
  assert.deepEqual({ ...first, statement: undefined }, { level: 'info', msg: 'db_sample', route: null, command: 'SELECT', tables: ['coordinator_messages', 'bots'], statement: undefined, rows: 2, bytes: Buffer.byteLength(JSON.stringify(result.rows)) })
  assert.match(first.statement, /^[0-9a-f]{12}$/)
  assert.deepEqual(second.tables, ['agent_runs'])
  assert.ok(!lines.join('\n').includes('PRIVATE'), 'no values reach the log')
})

test('unsampled queries pass straight through and the rate is bounded', async () => {
  const lines: string[] = []
  const client = fakeClient()
  sampleClient(client, 0.01, () => 0.5, line => lines.push(line))
  assert.equal(await client.query('select 1'), result)
  assert.equal(lines.length, 0)
  assert.equal(sampleRate({}), 0.01)
  assert.equal(sampleRate({ DB_EGRESS_SAMPLE_RATE: '0' }), 0)
  assert.equal(sampleRate({ DB_EGRESS_SAMPLE_RATE: '7' }), 1)
  assert.equal(sampleRate({ DB_EGRESS_SAMPLE_RATE: 'nope' }), 0)
  assert.equal(describeSample('BEGIN', { command: 'BEGIN', rows: [] } as never, 'r').bytes, 0)
})
