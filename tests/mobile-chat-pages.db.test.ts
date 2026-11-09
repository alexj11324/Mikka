import { seedFixtureWorkspace } from './helpers/task-workspace'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { disposableDatabase } from './helpers/e2e-target.mjs'

// Only a disposable loopback *_e2e database is admissible; required in CI.
const required = process.env.REQUIRE_DB === '1'
const enabled = disposableDatabase()
if (required && !enabled) throw new Error('Mobile chat page test requires a loopback *_e2e database')

/** The bytes of a JSON response body, as /api/mobile/chat sends it. */
const bodyBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))

test('the app reads a chat a page at a time: 50 first, older pages by `through`, only what is new on a push (#1408)', { skip: !enabled, timeout: 120_000 }, async t => {
  const { pool } = await import('../lib/db')
  const store = await import('../lib/coordinator/store')
  const owner = `mobile-pages-${randomUUID()}`, botId = randomUUID()
  await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,false,now(),now())', [owner, `${owner}@example.invalid`])
  await pool.query('insert into bots(id,"ownerId","workspaceId",name) values($1,$2,$3,$4)', [botId, owner, await seedFixtureWorkspace(pool, owner), 'Coordinator'])
  const add = async (position: number) => {
    const text = `Turn ${position}: ${'a long report line '.repeat(80)}`
    const message = position % 2 ? { role: 'user', content: text } : { role: 'assistant', content: [{ type: 'text', text }] }
    await pool.query('insert into coordinator_messages(id,"userId","botId",position,message) values($1,$2,$3,$4,$5)', [randomUUID(), owner, botId, position, JSON.stringify(message)])
  }
  try {
    // 200 turns of about 1.5 KB each, alternating person and Coordinator.
    for (let position = 1; position <= 200; position++) await add(position)
    const before = await store.chatView(owner, 200, botId)
    const first = await store.chatUpdate(owner, botId)
    assert.equal(first.items.length, store.CHAT_FIRST_PAGE)
    assert.ok(first.continuation && first.historyBefore, 'the first page says where to continue and that older messages exist')

    // Scrolling to the top: the page before, overlapping the first shown item as the app asks.
    const through = first.items[1]!.position - 1
    const older = await store.chatView(owner, store.CHAT_FIRST_PAGE, botId, { through })
    assert.equal(older.items.length, store.CHAT_FIRST_PAGE)
    assert.equal(older.items.at(-1)!.position, through)

    // A push after one new message: the read continues from the first page's continuation.
    await add(201)
    const update = await store.chatUpdate(owner, botId, first.continuation)
    assert.ok('after' in update && update.after === first.continuation!.after, 'an update read')
    assert.deepEqual(update.items.map(item => item.position), [200, 201], 'the last shown item again, and the new one')

    const bytes = { full200: bodyBytes(before), firstPage50: bodyBytes(first), olderPage50: bodyBytes(older), updateOneMessage: bodyBytes(update) }
    t.diagnostic(JSON.stringify(bytes))
    assert.ok(bytes.firstPage50 < bytes.full200 / 3, JSON.stringify(bytes))
    assert.ok(bytes.updateOneMessage < bytes.firstPage50 / 10, JSON.stringify(bytes))
  } finally {
    await pool.query('delete from coordinator_messages where "userId"=$1', [owner])
    await pool.query('delete from bots where id=$1', [botId])
    await pool.query('delete from mikka_workspace_members where "userId"=$1', [owner])
    await pool.query('delete from mikka_workspaces where "userId"=$1', [owner])
    await pool.query('delete from "user" where id=$1', [owner])
  }
})
