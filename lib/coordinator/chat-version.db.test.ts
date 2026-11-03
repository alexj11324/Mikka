import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { isE2eTarget } from '../../tests/helpers/e2e-target.mjs'

// Database regressions execute only in CI against ephemeral Postgres 17.
// Local pure runs skip them; REQUIRE_DB=1 makes a missing database fail.
let databaseUrl: string | undefined
try {
  const target = new URL(process.env.E2E_DATABASE_URL ?? '')
  if (isE2eTarget(target.href) && process.env.MIKKA_DATABASE_URL === target.href
    && process.env.DATABASE_URL === target.href) databaseUrl = target.href
} catch { /* no eligible disposable CI database */ }
if (!databaseUrl && process.env.REQUIRE_DB === '1') throw new Error('REQUIRE_DB=1 requires the matching Actions loopback mikka_e2e database')
const dbTest = databaseUrl ? test : test.skip

dbTest('the chat version changes exactly when the conversation or its inbox does, and costs a few bytes', async t => {
  const [{ createRequestDatabaseScope, db }, schema, store, { recordCoordinatorEvent }, { userMessageEvent }, { and, eq, sql }] = await Promise.all([
    import('../db'), import('../db/schema'), import('./store'), import('../coordinator-event-store'), import('../coordinator-events'), import('drizzle-orm'),
  ])
  const scope = createRequestDatabaseScope(databaseUrl!)
  const owner = `test-chat-version-${randomUUID()}`, botId = randomUUID(), otherBot = randomUUID()
  t.after(async () => {
    await scope.run(async () => {
      await db.delete(schema.coordinatorEvents).where(eq(schema.coordinatorEvents.userId, owner))
      await db.delete(schema.coordinatorMessages).where(eq(schema.coordinatorMessages.userId, owner))
      await db.delete(schema.bots).where(eq(schema.bots.ownerId, owner))
      await db.execute(sql`delete from "user" where id = ${owner}`)
    })
    await scope.close()
  })
  await scope.run(async () => {
    await db.execute(sql`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values (${owner}, 'Version fixture', ${`${owner}@example.invalid`}, false, now(), now())`)
    await db.insert(schema.bots).values([{ id: botId, ownerId: owner, workspaceId: randomUUID(), name: 'Version bot' }, { id: otherBot, ownerId: owner, workspaceId: randomUUID(), name: 'Other bot' }])
    const empty = await store.chatVersion(owner, 200, botId)
    assert.deepEqual({ ...empty, version: undefined }, { version: undefined, cursor: 0, working: false, error: null })

    const reply = 'A long answer. '.repeat(200)
    await db.insert(schema.coordinatorMessages).values(Array.from({ length: 40 }, (_, index) => ({
      id: randomUUID(), userId: owner, botId, position: index + 1,
      message: index % 2 ? { role: 'assistant', mikkaStreamId: `s-${index}`, content: [{ type: 'text', text: reply }] } : { role: 'user', content: `question ${index}` },
    })))
    const first = await store.chatVersion(owner, 200, botId)
    assert.notEqual(first.version, empty.version)
    assert.equal(first.cursor, 40)
    assert.deepEqual(await store.chatVersion(owner, 200, botId), first, 'nothing changed: the same version')

    await db.insert(schema.coordinatorMessages).values({ id: randomUUID(), userId: owner, botId: otherBot, position: 1, message: { role: 'user', content: 'elsewhere' } })
    assert.equal((await store.chatVersion(owner, 200, botId)).version, first.version, 'another bot\'s chat is not this one')

    await db.update(schema.coordinatorMessages).set({ message: { role: 'assistant', mikkaStopped: true, content: [{ type: 'text', text: 'stopped' }] } })
      .where(and(eq(schema.coordinatorMessages.userId, owner), eq(schema.coordinatorMessages.botId, botId), eq(schema.coordinatorMessages.position, 40)))
    const edited = await store.chatVersion(owner, 200, botId)
    assert.notEqual(edited.version, first.version, 'a stored message rewritten in place changes the version')

    await recordCoordinatorEvent(db, userMessageEvent(owner, 'A new question', { botId }))
    const waiting = await store.chatVersion(owner, 200, botId)
    assert.notEqual(waiting.version, edited.version, 'a message waiting in the inbox changes the version')
    assert.equal(waiting.working, true)
    assert.equal(waiting.cursor, 40)

    const full = Buffer.byteLength(JSON.stringify(await store.chatView(owner, 200, botId)))
    const poll = Buffer.byteLength(JSON.stringify({ unchanged: true, ...waiting }))
    t.diagnostic(JSON.stringify({ event: 'chat_poll_bytes', full, unchanged: poll }))
    assert.ok(poll * 50 < full, `unchanged poll ${poll} bytes, full read ${full}`)
  })
})
