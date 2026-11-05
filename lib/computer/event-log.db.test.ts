import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Pool } from 'pg'
import { isE2eTarget } from '../../tests/helpers/e2e-target.mjs'
import { lockSubagentEvents, readComputerEvents } from './event-log'

const databaseURL = process.env.COMPUTER_TEST_DATABASE_URL ?? process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !databaseURL) throw new Error('Computer event database URL required')
if (databaseURL && !isE2eTarget(databaseURL)) throw new Error('Computer event tests require an isolated loopback e2e database')

test('real PostgreSQL: bounded cursor pages, owner/workspace isolation and commit-ordered sequence allocation', { skip: !databaseURL }, async () => {
  const schema = `computer_events_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseURL })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}`, max: 4 })
  const a = { ownerId: 'alice', workspaceId: randomUUID() }
  const b = { ownerId: 'bob', workspaceId: a.workspaceId }
  const other = { ...a, workspaceId: randomUUID() }
  const insert = async (client: Pick<Pool, 'query'>, scope: typeof a, value: string) => (await client.query(
    'INSERT INTO subagent_events("ownerId","workspaceId",event) VALUES($1,$2,$3) RETURNING seq',
    [scope.ownerId, scope.workspaceId, { type: 'data-subagent', data: { value } }],
  )).rows[0].seq as string
  try {
    await pool.query('CREATE TABLE subagent_events(seq bigserial PRIMARY KEY,"ownerId" text NOT NULL,"workspaceId" uuid NOT NULL,event jsonb NOT NULL)')
    await insert(pool, b, 'other owner'); await insert(pool, other, 'other workspace')
    for (let i = 0; i < 102; i++) await insert(pool, a, String(i))
    const first = await readComputerEvents(pool, a, '0')
    assert.equal(first.events.length, 100)
    assert.equal(first.hasMore, true)
    assert.equal(first.events[0].data && (first.events[0].data as { value: string }).value, '0')
    const second = await readComputerEvents(pool, a, first.cursor)
    assert.equal(second.events.length, 2)
    assert.equal(second.hasMore, false)
    assert.equal((await readComputerEvents(pool, b, '0')).events.length, 1)
    assert.equal((await readComputerEvents(pool, other, '0')).events.length, 1)
    await assert.rejects(readComputerEvents(pool, a, '9223372036854775808'), /Invalid/)

    const one = await pool.connect(), two = await pool.connect()
    try {
      await one.query('BEGIN'); await lockSubagentEvents(one, a)
      const seq1 = await insert(one, a, 'uncommitted one')
      assert.equal((await readComputerEvents(pool, a, second.cursor)).events.length, 0, 'uncommitted content cannot be fetched')
      await two.query('BEGIN')
      const key = `subagent-events:${a.ownerId}:${a.workspaceId}`
      assert.equal((await two.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired', [key])).rows[0].acquired, false)
      const otherKey = `subagent-events:${b.ownerId}:${b.workspaceId}`
      assert.equal((await two.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired', [otherKey])).rows[0].acquired, true, 'other owners do not contend')
      const waiting = lockSubagentEvents(two, a)
      await one.query('COMMIT')
      await waiting
      const seq2 = await insert(two, a, 'later transaction')
      assert.ok(BigInt(seq2) > BigInt(seq1))
      const committedFirst = await readComputerEvents(pool, a, second.cursor)
      assert.deepEqual(committedFirst.events.map(e => e.id), [seq1])
      await two.query('COMMIT')
      assert.deepEqual((await readComputerEvents(pool, a, committedFirst.cursor)).events.map(e => e.id), [seq2], 'after the first commit cannot skip the second writer')

      await one.query('BEGIN'); await lockSubagentEvents(one, a)
      await insert(one, a, 'rolled back')
      await one.query('ROLLBACK')
      assert.deepEqual(await readComputerEvents(pool, a, seq2), { events: [], cursor: seq2, hasMore: false })
      await pool.query("SELECT setval(pg_get_serial_sequence('subagent_events','seq'),9007199254740993)")
      const precise = await insert(pool, a, 'large cursor')
      assert.equal(precise, '9007199254740994')
      assert.equal((await readComputerEvents(pool, a, seq2)).cursor, precise)
    } finally {
      await one.query('ROLLBACK').catch(() => {}); await two.query('ROLLBACK').catch(() => {})
      one.release(); two.release()
    }
  } finally {
    await pool.end()
    await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    await admin.end()
  }
})
