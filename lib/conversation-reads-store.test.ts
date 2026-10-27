import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { after, before, type TestContext } from 'node:test'
import { Pool } from 'pg'
import { handleRead, originAllowed, requestHost, resolveMessage, type ReadRequest } from './conversation-reads-store'

// Pure checks always run. DB checks need a reachable MIKKA_DATABASE_URL whose
// schema already has conversation_reads (applied by scripts/migrate.mjs; the
// test never creates tables) and skip otherwise, e.g. in the UI policy CI job.
// CONVERSATION_READS_REQUIRE_DB=1 turns that skip into a failure (CI DB job).
// Locally: ~/.mikka/local-run.sh pnpm test:conversation-reads

test('request host: first x-forwarded-host value wins, Host is the fallback', () => {
  assert.equal(requestHost('mikka.app, internal:3000', 'internal:3000'), 'mikka.app')
  assert.equal(requestHost(null, 'localhost:3000'), 'localhost:3000')
  assert.equal(requestHost('', 'localhost:3000'), 'localhost:3000')
  assert.equal(requestHost(null, null), null)
})

test('origin: missing allowed, same host allowed, cross host and garbage rejected', () => {
  assert.equal(originAllowed(null, 'mikka.app'), true)
  assert.equal(originAllowed('https://mikka.app', 'mikka.app'), true)
  assert.equal(originAllowed('http://localhost:3100', 'localhost:3100'), true)
  assert.equal(originAllowed('https://evil.example', 'mikka.app'), false)
  assert.equal(originAllowed('http://localhost:3101', 'localhost:3100'), false)
  assert.equal(originAllowed('null', 'mikka.app'), false)
})

test('positions outside PostgreSQL integer bounds are rejected before a query', async () => {
  const q = { query: async () => { throw new Error('invalid position reached PostgreSQL') } }
  for (const value of ['2147483648', '9999999999', '10000000000', '0', '-1']) {
    assert.equal(await resolveMessage(q, 'owner', value), null)
  }
})

async function probe(url: string | undefined): Promise<Pool | string> {
  if (!url) return 'MIKKA_DATABASE_URL not set (run via ~/.mikka/local-run.sh)'
  const candidate = new Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 5000 })
  try {
    const { rows } = await candidate.query("select to_regclass('conversation_reads') is not null as ok")
    if (rows[0]?.ok) return candidate
    await candidate.end()
    return 'conversation_reads missing: apply migrations with scripts/migrate.mjs first'
  } catch (error) {
    await candidate.end().catch(() => {})
    return `database unreachable (${(error as Error).message})`
  }
}
let pool: Pool | null = null
let skipReason = ''
/** Skips the calling test when there is no database; else returns true. */
const needDb = (t: TestContext) => { if (!pool) t.skip(skipReason); return Boolean(pool) }
const alice = `test-reads-${randomUUID()}`
const bob = `test-reads-${randomUUID()}`
const ids: Record<string, string> = {}
// alice's bot chats on the same harness, numbering its own messages from 1.
const aliceBot = randomUUID()
const bobBot = randomUUID()
const host = 'localhost:3000'
const req = (over: Partial<ReadRequest>): ReadRequest => ({ method: 'GET', userId: alice, conversationId: 'coordinator', origin: null, host, ...over })
const post = (messageId: unknown, over: Partial<ReadRequest> = {}) => handleRead(pool!, req({ method: 'POST', body: JSON.stringify({ messageId }), ...over }))

before(async () => {
  const probed = await probe(process.env.MIKKA_DATABASE_URL)
  if (typeof probed === 'string') {
    // CI with a real Postgres service sets this so a broken DB fails loudly instead of skipping.
    if (process.env.CONVERSATION_READS_REQUIRE_DB === '1') throw new Error(`CONVERSATION_READS_REQUIRE_DB=1 but ${probed}`)
    skipReason = probed
    return
  }
  pool = probed
  // alice: 1 user, 2 assistant(+tool)+3 assistant = one reply, 4 user, 5 assistant, 6 event (user) ; bob: 1 assistant
  const rows: [string, string, number, object][] = [
    ['a1', alice, 1, { role: 'user', content: 'hi' }],
    ['a2', alice, 2, { role: 'assistant', content: [{ type: 'tool-call', toolName: 'x', toolCallId: 't', input: {} }] }],
    ['a2t', alice, 3, { role: 'tool', content: [] }],
    ['a3', alice, 4, { role: 'assistant', content: 'answer' }],
    ['a4', alice, 5, { role: 'user', content: 'more' }],
    ['a5', alice, 6, { role: 'assistant', content: 'again' }],
    ['b1', bob, 1, { role: 'assistant', content: 'bob only' }],
  ]
  for (const [key, userId, position, message] of rows) {
    ids[key] = randomUUID()
    await pool.query('insert into coordinator_messages (id, "userId", position, message) values ($1, $2, $3, $4)', [ids[key], userId, position, message])
  }
  await pool.query('insert into bots (id, "userId", name) values ($1, $2, $3), ($4, $5, $6)', [aliceBot, alice, 'Writer', bobBot, bob, 'Helper'])
  for (const [key, position, message] of [['w1', 1, { role: 'user', content: 'hi Writer' }], ['w2', 2, { role: 'assistant', content: 'Writer here' }]] as const) {
    ids[key] = randomUUID()
    await pool.query('insert into coordinator_messages (id, "userId", "botId", position, message) values ($1, $2, $3, $4, $5)', [ids[key], alice, aliceBot, position, message])
  }
})

after(async () => {
  if (!pool) return
  await pool.query('delete from conversation_reads where "userId" = any($1)', [[alice, bob]])
  await pool.query('delete from coordinator_messages where "userId" = any($1)', [[alice, bob]])
  await pool.query('delete from bots where id = any($1)', [[aliceBot, bobBot]])
  await pool.end()
})

test('auth, membership and origin status codes', async t => {
  if (!needDb(t)) return
  assert.equal((await handleRead(pool!, req({ userId: null }))).status, 401)
  assert.equal((await handleRead(pool!, req({ conversationId: 'someone-elses' }))).status, 404)
  assert.equal((await post('1', { conversationId: 'group-123' })).status, 404)
  assert.equal((await post('1', { origin: 'https://evil.example' })).status, 403)
  assert.equal((await handleRead(pool!, req({ origin: 'https://evil.example' }))).status, 403)
  assert.equal((await handleRead(pool!, req({ origin: `http://${host}` }))).status, 200)
  assert.equal((await handleRead(pool!, req({ origin: null }))).status, 200)
})

test('GET before any read: nothing read, every reply unread', async t => {
  if (!needDb(t)) return
  const result = await handleRead(pool!, req({}))
  assert.deepEqual(result, { status: 200, body: { lastReadMessageId: null, lastReadPosition: null, unreadCount: 2 } })
})

test('422: missing, malformed, unknown and cross-conversation ids', async t => {
  if (!needDb(t)) return
  assert.equal((await handleRead(pool!, req({ method: 'POST', body: '' }))).status, 422)
  assert.equal((await handleRead(pool!, req({ method: 'POST', body: '{}' }))).status, 422)
  assert.equal((await handleRead(pool!, req({ method: 'POST', body: 'not json' }))).status, 422)
  assert.equal((await post(42)).status, 422)
  assert.equal((await post('abc')).status, 422)
  assert.equal((await post('999')).status, 422)
  assert.equal((await post(randomUUID())).status, 422)
  assert.equal((await post(ids.b1)).status, 422, "bob's message id in alice's conversation")
})

test('position string and uuid both accepted; older position ignored', async t => {
  if (!needDb(t)) return
  const first = await post('4')
  assert.deepEqual(first, { status: 200, body: { lastReadMessageId: ids.a3, lastReadPosition: 4, unreadCount: 1 } }, 'position string is stored as the uuid')
  const stored = await pool!.query('select "lastReadMessageId" from conversation_reads where "userId" = $1', [alice])
  assert.equal(stored.rows[0].lastReadMessageId, ids.a3)
  const older = await post(ids.a1)
  assert.deepEqual(older, first, 'older read returns current state, no error')
  const byUuid = await post(ids.a5)
  assert.deepEqual(byUuid, { status: 200, body: { lastReadMessageId: ids.a5, lastReadPosition: 6, unreadCount: 0 } })
  assert.deepEqual(await handleRead(pool!, req({})), byUuid)
  // text/plain beacon body is the same JSON string; handleRead never looks at Content-Type.
})

test('concurrent writes never move backward', async t => {
  if (!needDb(t)) return
  await pool!.query('delete from conversation_reads where "userId" = $1', [alice])
  const positions = [6, 2, 5, 1, 4, 3, 6, 2, 1, 5, 4, 3]
  const all = await Promise.all(positions.map(p => post(String(p))))
  for (const r of all) assert.equal(r.status, 200)
  const final = await handleRead(pool!, req({}))
  assert.equal(final.status, 200)
  assert.equal((final.body as { lastReadPosition: number }).lastReadPosition, 6)
  assert.equal((final.body as { lastReadMessageId: string }).lastReadMessageId, ids.a5)
  // Every response reflects a monotonic state: no response is below the position it asked for.
  all.forEach((r, i) => assert.ok((r.body as { lastReadPosition: number }).lastReadPosition >= positions[i]))
})

test("a bot's chat keeps its own read position and unread count", async t => {
  if (!needDb(t)) return
  const writer = `bot:${aliceBot}`
  assert.equal((await handleRead(pool!, req({ conversationId: `bot:${bobBot}` }))).status, 404, "another person's bot")
  assert.equal((await handleRead(pool!, req({ conversationId: `bot:${randomUUID()}` }))).status, 404, 'no such bot')
  assert.deepEqual(await handleRead(pool!, req({ conversationId: writer })), { status: 200, body: { lastReadMessageId: null, lastReadPosition: null, unreadCount: 1 } })
  assert.equal((await post(ids.a3, { conversationId: writer })).status, 422, "a Coordinator message id in the bot's chat")
  assert.deepEqual(await post('2', { conversationId: writer }), { status: 200, body: { lastReadMessageId: ids.w2, lastReadPosition: 2, unreadCount: 0 } }, "position 2 is the bot's own message 2")
  const coordinator = await handleRead(pool!, req({}))
  assert.notEqual((coordinator.body as { lastReadMessageId: string | null }).lastReadMessageId, ids.w2, "reading the bot's chat leaves the Coordinator's alone")
})
