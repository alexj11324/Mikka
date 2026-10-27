import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

// Every bot chats on the Coordinator harness; botId keeps their chats apart.
// Database regressions execute only in CI against ephemeral Postgres 17.
// Local pure runs skip them; REQUIRE_DB=1 makes a missing database fail.
let databaseUrl: string | undefined
try {
  const target = new URL(process.env.E2E_DATABASE_URL ?? '')
  if (process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true'
    && ['postgres:', 'postgresql:'].includes(target.protocol)
    && target.hostname === '127.0.0.1' && target.port === '5432' && target.pathname === '/mikka_e2e'
    && !target.search && !target.hash && process.env.MIKKA_DATABASE_URL === target.href
    && process.env.DATABASE_URL === target.href) databaseUrl = target.href
} catch { /* no eligible disposable CI database */ }
if (!databaseUrl && process.env.REQUIRE_DB === '1') throw new Error('REQUIRE_DB=1 requires the matching Actions loopback mikka_e2e database')
const dbTest = databaseUrl ? test : test.skip

dbTest('a bot and the Coordinator keep their own conversation, inbox and memory', async t => {
  const [{ createRequestDatabaseScope, db }, schema, store, { recordCoordinatorEvent }, { userMessageEvent }, { eq, inArray }] = await Promise.all([
    import('../db'), import('../db/schema'), import('./store'), import('../coordinator-event-store'), import('../coordinator-events'), import('drizzle-orm'),
  ])
  const scope = createRequestDatabaseScope(databaseUrl!)
  const userId = `test-bot-chats-${randomUUID()}`
  const botId = randomUUID()
  t.after(async () => {
    await scope.run(async () => {
      await db.delete(schema.coordinatorEvents).where(eq(schema.coordinatorEvents.userId, userId))
      await db.delete(schema.coordinatorMessages).where(eq(schema.coordinatorMessages.userId, userId))
      await db.delete(schema.coordinatorSessions).where(eq(schema.coordinatorSessions.userId, userId))
      await db.delete(schema.bots).where(inArray(schema.bots.id, [botId]))
    })
    await scope.close()
  })
  await scope.run(async () => {
    await db.insert(schema.bots).values({ id: botId, userId, name: 'Writer' })
    await recordCoordinatorEvent(db, userMessageEvent(userId, 'to the Coordinator'))
    await recordCoordinatorEvent(db, userMessageEvent(userId, 'to Writer', { botId }))
    assert.deepEqual((await store.wakingChats(userId)).sort(), [botId, null].sort(), 'one wake per chat with waiting messages')

    const bot = await store.takeInbox(userId, 'turn-bot', botId)
    assert.deepEqual([bot.held, bot.added], [true, 1], "the bot's turn takes only its own message")
    // The bot holding its lease does not block the Coordinator's turn.
    const coordinator = await store.takeInbox(userId, 'turn-coordinator')
    assert.deepEqual([coordinator.held, coordinator.added], [true, 1])
    await store.appendMessages(userId, 'turn-bot', [{ role: 'assistant', content: 'Writer here' }], null, botId)
    await store.appendMessages(userId, 'turn-coordinator', [{ role: 'assistant', content: 'Coordinator here' }])

    const botView = await store.chatView(userId, 200, botId)
    assert.deepEqual(botView.items.map(item => item.text), ['to Writer', 'Writer here'])
    const coordinatorView = await store.chatView(userId)
    assert.deepEqual(coordinatorView.items.map(item => item.text), ['to the Coordinator', 'Coordinator here'])
    // Each chat numbers its own messages from 1.
    assert.deepEqual(botView.items.map(item => item.position), [1, 2])
    assert.deepEqual(coordinatorView.items.map(item => item.position), [1, 2])

    await store.editMemory(userId, () => ({ memory: '- likes short replies', result: null }), botId)
    assert.equal((await store.loadConversation(userId, botId)).memory, '- likes short replies')
    assert.equal((await store.loadConversation(userId)).memory, '', "a bot's memory is its own")

    await store.releaseLease(userId, 'turn-bot', botId)
    const summaries = await store.botChats(userId)
    assert.deepEqual(Object.keys(summaries), [botId], 'the bot list summarises bots only')
    assert.equal(summaries[botId].line, 'Writer here')
    assert.equal(summaries[botId].working, false)
  })
})
