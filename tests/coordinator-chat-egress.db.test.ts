import { seedFixtureWorkspace } from './helpers/task-workspace'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Socket } from 'node:net'
import test from 'node:test'
import { disposableDatabase } from './helpers/e2e-target.mjs'

// Only a disposable loopback *_e2e database is admissible; required in CI.
const required = process.env.REQUIRE_DB === '1'
const enabled = disposableDatabase()
if (required && !enabled) throw new Error('Coordinator chat egress test requires a loopback *_e2e database')

// Every byte the database sends to this process.
const sockets = new Set<Socket>()
const connect = Socket.prototype.connect
Socket.prototype.connect = function (this: Socket, ...args: unknown[]) { sockets.add(this); return Reflect.apply(connect, this, args) } as typeof Socket.prototype.connect
const received = () => [...sockets].reduce((sum, socket) => sum + socket.bytesRead, 0)
async function measured<T>(work: () => Promise<T>) { const before = received(); const value = await work(); return { value, bytes: received() - before } }

test('the chat\'s first read is one page and the bot list reads a summary, not the chat (#1414)', { skip: !enabled, timeout: 120_000 }, async t => {
  const { pool } = await import('../lib/db')
  const store = await import('../lib/coordinator/store')
  const owner = `chat-egress-${randomUUID()}`, botId = randomUUID()
  await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,false,now(),now())', [owner, `${owner}@example.invalid`])
  await pool.query('insert into bots(id,"ownerId","workspaceId",name) values($1,$2,$3,$4)', [botId, owner, await seedFixtureWorkspace(pool, owner), 'Coordinator'])
  // 200 turns of about 1.5 KB each, alternating person and Coordinator.
  for (let position = 1; position <= 200; position++) {
    const text = `Turn ${position}: ${'a long report line '.repeat(80)}`
    const message = position % 2 ? { role: 'user', content: text } : { role: 'assistant', content: [{ type: 'text', text }] }
    await pool.query('insert into coordinator_messages(id,"userId","botId",position,message) values($1,$2,$3,$4,$5)', [randomUUID(), owner, botId, position, JSON.stringify(message)])
  }
  const before = await measured(() => store.chatView(owner, 200, botId))
  const first = await measured(() => store.chatUpdate(owner, botId))
  const summary = await measured(() => store.botChatSnapshot(owner))
  assert.equal(before.value.items.length, 200)
  assert.equal(first.value.items.length, store.CHAT_FIRST_PAGE)
  assert.ok(first.value.historyBefore, 'older messages load a page at a time')
  assert.ok(summary.value.items[botId]?.line?.startsWith('Turn 200'))
  assert.ok(first.bytes < before.bytes / 3, JSON.stringify({ before: before.bytes, first: first.bytes }))
  assert.ok(summary.bytes < before.bytes / 20, JSON.stringify({ before: before.bytes, summary: summary.bytes }))
  t.diagnostic(JSON.stringify({ fullChat200Bytes: before.bytes, firstPage50Bytes: first.bytes, botListSummaryBytes: summary.bytes }))
  await pool.query('delete from coordinator_messages where "userId"=$1', [owner])
  await pool.query('delete from bots where id=$1', [botId])
})
