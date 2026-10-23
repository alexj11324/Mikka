import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test, { after, before } from 'node:test'
import { Pool } from 'pg'
import { handleRead, originAllowed, type ReadRequest } from './conversation-reads-store'

// Pure checks always run; DB checks need MIKKA_DATABASE_URL (dev-local via
// ~/.mikka/local-run.sh) and skip without it.

test('origin: missing allowed, same host allowed, cross host and garbage rejected', () => {
  assert.equal(originAllowed(null, 'mikka.app'), true)
  assert.equal(originAllowed('https://mikka.app', 'mikka.app'), true)
  assert.equal(originAllowed('http://localhost:3100', 'localhost:3100'), true)
  assert.equal(originAllowed('https://evil.example', 'mikka.app'), false)
  assert.equal(originAllowed('http://localhost:3101', 'localhost:3100'), false)
  assert.equal(originAllowed('null', 'mikka.app'), false)
})

const url = process.env.MIKKA_DATABASE_URL
const skip = url ? false : 'MIKKA_DATABASE_URL not set (run via ~/.mikka/local-run.sh)'
const pool = url ? new Pool({ connectionString: url, max: 10 }) : null
const alice = `test-reads-${randomUUID()}`
const bob = `test-reads-${randomUUID()}`
const ids: Record<string, string> = {}
const host = 'localhost:3000'
const req = (over: Partial<ReadRequest>): ReadRequest => ({ method: 'GET', userId: alice, conversationId: 'coordinator', origin: null, host, ...over })
const post = (messageId: unknown, over: Partial<ReadRequest> = {}) => handleRead(pool!, req({ method: 'POST', body: JSON.stringify({ messageId }), ...over }))

before(async () => {
  if (!pool) return
  await pool.query(readFileSync(new URL('../drizzle/0019_conversation_reads.sql', import.meta.url), 'utf8'))
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
})

after(async () => {
  if (!pool) return
  await pool.query('delete from conversation_reads where "userId" = any($1)', [[alice, bob]])
  await pool.query('delete from coordinator_messages where "userId" = any($1)', [[alice, bob]])
  await pool.end()
})

test('auth, membership and origin status codes', { skip }, async () => {
  assert.equal((await handleRead(pool!, req({ userId: null }))).status, 401)
  assert.equal((await handleRead(pool!, req({ conversationId: 'someone-elses' }))).status, 404)
  assert.equal((await post('1', { conversationId: 'group-123' })).status, 404)
  assert.equal((await post('1', { origin: 'https://evil.example' })).status, 403)
  assert.equal((await handleRead(pool!, req({ origin: 'https://evil.example' }))).status, 403)
  assert.equal((await handleRead(pool!, req({ origin: `http://${host}` }))).status, 200)
  assert.equal((await handleRead(pool!, req({ origin: null }))).status, 200)
})

test('GET before any read: nothing read, every reply unread', { skip }, async () => {
  const result = await handleRead(pool!, req({}))
  assert.deepEqual(result, { status: 200, body: { lastReadMessageId: null, lastReadPosition: null, unreadCount: 2 } })
})

test('422: missing, malformed, unknown and cross-conversation ids', { skip }, async () => {
  assert.equal((await handleRead(pool!, req({ method: 'POST', body: '' }))).status, 422)
  assert.equal((await handleRead(pool!, req({ method: 'POST', body: '{}' }))).status, 422)
  assert.equal((await handleRead(pool!, req({ method: 'POST', body: 'not json' }))).status, 422)
  assert.equal((await post(42)).status, 422)
  assert.equal((await post('abc')).status, 422)
  assert.equal((await post('999')).status, 422)
  assert.equal((await post(randomUUID())).status, 422)
  assert.equal((await post(ids.b1)).status, 422, "bob's message id in alice's conversation")
})

test('position string and uuid both accepted; older position ignored', { skip }, async () => {
  const first = await post('4')
  assert.deepEqual(first, { status: 200, body: { lastReadMessageId: '4', lastReadPosition: 4, unreadCount: 1 } })
  const older = await post(ids.a1)
  assert.deepEqual(older, first, 'older read returns current state, no error')
  const byUuid = await post(ids.a5)
  assert.deepEqual(byUuid, { status: 200, body: { lastReadMessageId: ids.a5, lastReadPosition: 6, unreadCount: 0 } })
  assert.deepEqual(await handleRead(pool!, req({})), byUuid)
  // text/plain beacon body is the same JSON string; handleRead never looks at Content-Type.
})

test('concurrent writes never move backward', { skip }, async () => {
  await pool!.query('delete from conversation_reads where "userId" = $1', [alice])
  const positions = [6, 2, 5, 1, 4, 3, 6, 2, 1, 5, 4, 3]
  const all = await Promise.all(positions.map(p => post(String(p))))
  for (const r of all) assert.equal(r.status, 200)
  const final = await handleRead(pool!, req({}))
  assert.equal(final.status, 200)
  assert.equal((final.body as { lastReadPosition: number }).lastReadPosition, 6)
  assert.equal((final.body as { lastReadMessageId: string }).lastReadMessageId, '6')
  // Every response reflects a monotonic state: no response is below the position it asked for.
  all.forEach((r, i) => assert.ok((r.body as { lastReadPosition: number }).lastReadPosition >= positions[i]))
})
