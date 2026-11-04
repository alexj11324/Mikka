import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import test, { mock } from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { dropTestDatabase } from '../../tests/support/drop-test-database'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { observePoolCommits } from '../db/commit-effects'

const url = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1') assert.ok(url, 'REQUIRE_DB=1 needs PostgreSQL')
if (url) assert.ok(disposableDatabase(process.env, url), 'loopback *_e2e only')

test('the real Factory store schedules one invalidation only after its outer transaction commits', { skip: !url, timeout: 180_000 }, async t => {
  const pending: (() => Promise<void>)[] = []
  const notification = mock.module('./notify', { namedExports: {
    scheduleLive: (work: () => Promise<void>) => { pending.push(work) },
    sendLiveInvalidations: async () => {},
  } })
  const previous = { url: process.env.DEVICE_GATEWAY_URL, secret: process.env.DEVICE_GATEWAY_PUSH_SECRET }
  process.env.DEVICE_GATEWAY_URL = 'https://gateway.example.invalid'
  process.env.DEVICE_GATEWAY_PUSH_SECRET = 'isolated-live-test-secret'
  const admin = new Pool({ connectionString: url, max: 1 })
  const database = `factory_live_${randomUUID().replaceAll('-', '')}_e2e`
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`)
  const target = new URL(url!); target.pathname = `/${database}`
  const pool = new Pool({ connectionString: target.toString(), max: 4 })
  observePoolCommits(pool)
  try {
    const dir = new URL('../../drizzle/', import.meta.url)
    for (const name of orderMigrations((await readdir(dir)).filter(name => name.endsWith('.sql')))) await pool.query(await readFile(new URL(name, dir), 'utf8'))
    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ('owner','Fixture','live@example.invalid',true,now(),now())`)
    const { createFactoryStore } = await import('../factory/store')
    const store = createFactoryStore(pool, async (owner, issue, tx) => (await tx.query('SELECT id FROM issues WHERE id=$1 AND "userId"=$2', [issue, owner])).rowCount === 1, null, {})
    async function input() {
      const issueId = randomUUID(), sourceEventId = randomUUID()
      await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority) VALUES ($1,'owner','Fixture','{"type":"doc","content":[]}','todo','normal')`, [issueId])
      await pool.query(`INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload) VALUES ($1,'owner','user_message',$2,'{"text":"synthetic"}')`, [sourceEventId, sourceEventId])
      return { issueId, sourceEventId, eventId: randomUUID(), rationale: 'Requested task', missingInformation: [], missingPermissions: [], needsSpec: false }
    }
    await t.test('route waits for the caller COMMIT; reads and idempotent replay send nothing', async () => {
      const request = await input(), tx = await pool.connect()
      try {
        await tx.query('BEGIN')
        const routed = await store.route('owner', request, tx)
        assert.equal(pending.length, 0)
        assert.equal((await pool.query('SELECT id FROM factory_tasks WHERE id=$1', [routed.task.id])).rowCount, 0)
        await tx.query('COMMIT')
        assert.equal(pending.length, 1)
        assert.equal((await pool.query('SELECT id FROM factory_tasks WHERE id=$1', [routed.task.id])).rowCount, 1)
        await store.read('owner', routed.task.id)
        await store.route('owner', request)
        assert.equal(pending.length, 1)
      } finally { tx.release() }
    })
    await t.test('a route rolled back by its caller never schedules work', async () => {
      const request = await input(), tx = await pool.connect(), before = pending.length
      try {
        await tx.query('BEGIN')
        await store.route('owner', request, tx)
        await tx.query('ROLLBACK')
        assert.equal(pending.length, before)
        assert.equal((await pool.query('SELECT id FROM factory_tasks WHERE "issueId"=$1', [request.issueId])).rowCount, 0)
      } finally { tx.release() }
    })
  } finally {
    notification.restore()
    if (previous.url === undefined) delete process.env.DEVICE_GATEWAY_URL; else process.env.DEVICE_GATEWAY_URL = previous.url
    if (previous.secret === undefined) delete process.env.DEVICE_GATEWAY_PUSH_SECRET; else process.env.DEVICE_GATEWAY_PUSH_SECRET = previous.secret
    await dropTestDatabase(admin, database, pool)
    await admin.end()
  }
})
