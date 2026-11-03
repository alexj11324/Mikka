import assert from 'node:assert/strict'
import test from 'node:test'
import { Pool } from 'pg'
import { PgReceiveCollector } from './transport-sample'
import { assertE2eTarget } from '../../tests/helpers/e2e-target.mjs'

const connectionString = process.env.MIKKA_TRANSPORT_TEST_DATABASE_URL ?? process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !connectionString) throw new Error('Isolated transport test database is required')

test('isolated Postgres: queued queries and two clients equal socket counter deltas, including errors', { skip: !connectionString }, async () => {
  const target = assertE2eTarget(connectionString!)
  assert.ok(['localhost', '127.0.0.1'].includes(target.hostname))
  assert.match(target.pathname, /^\/mikka_(transport_)?e2e$/)
  const pool = new Pool({ connectionString, max: 2 })
  const lines: string[] = []; let tick: (() => void) | undefined; let now = 1_000
  const collector = new PgReceiveCollector({ on: () => true, now: () => now, sink: line => lines.push(line), schedule: callback => { tick = callback; return () => { tick = undefined } } })
  collector.watch(pool, 'request')
  const one = await pool.connect(), two = await pool.connect()
  const stream = (client: unknown) => (client as { connection: { stream: { bytesRead: number } } }).connection.stream
  const startOne = stream(one).bytesRead, startTwo = stream(two).bytesRead
  let jsonBytes = 0
  try {
    assert.equal((await one.query('select current_database() name')).rows[0].name, target.pathname.slice(1))
    const wide = `select ${Array.from({ length: 22 }, (_, i) => `${i} as "synthetic_column_${i}"`).join(',')} where false`
    const queries = Array.from({ length: 40 }, (_, i) => i % 2 ? wide : 'select true as ok')
    await Promise.all(queries.flatMap(sql => [one, two].map(async client => { const result = await client.query(sql); jsonBytes += Buffer.byteLength(JSON.stringify(result.rows)) })))
    await assert.rejects(one.query('select definitely_not_a_real_function()'))
    const expected = stream(one).bytesRead - startOne + stream(two).bytesRead - startTwo
    now += 60_000; tick!()
    const observed = JSON.parse(lines[0])
    assert.equal(observed.pgProtocolReceiveBytes, expected)
    assert.equal(observed.connections, 2)
    assert.equal(observed.unknownReadings, 0)
    assert.ok(expected > jsonBytes * 5, 'wide empty row-description results expose protocol bytes absent from row JSON')
    const removed = new Promise<void>(resolve => { let count = 0; pool.on('remove', () => { if (++count === 2) resolve() }) })
    one.release(true); two.release(true)
    await removed; await pool.end()
    assert.equal(lines.reduce((sum, line) => sum + JSON.parse(line).pgProtocolReceiveBytes, 0), expected)
    assert.equal(tick, undefined)
    console.log(JSON.stringify({ experiment: 'isolated_80_synthetic_queries_plus_identity_and_one_error', pgProtocolReceiveBytes: expected, rowsJsonBytes: jsonBytes, connections: 2, startupExcluded: true, supplierBytes: 'not_measured' }))
  } finally {
    // Ensure failed assertions also release this isolated test pool.
    if (!pool.ending) { one.release(true); two.release(true); await pool.end() }
  }
})
