import { seedFixtureWorkspace } from '../../tests/helpers/task-workspace'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { mergeChat } from './chat-poll'
import { isE2eTarget } from '../../tests/helpers/e2e-target.mjs'
import { measured, readMetrics } from '../../tests/helpers/read-metrics'
import { persistentReadData } from '../swr/cache-policy'
import type { ChatView } from './store'
import type { PoolClient } from 'pg'

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

// Keep cold loading of the application graph outside these cases' 30-second
// database deadline. A timed-out parent runs cleanup while its nested cases
// are still starting; their later FK/pool errors obscure the original timeout.
const snapshotRuntime = databaseUrl ? await Promise.all([
  import('../db'), import('../db/schema'), import('./store'), import('../coordinator-events'), import('../chat-failure'), import('drizzle-orm'),
]) : null

/** Commit the real inbox claim after PostgreSQL has answered the first state
 * statement, before the reader can issue another. No sleeps or fake SQL rows. */
async function claimBetweenChatReads<T>(reader: PoolClient, claim: () => Promise<void>, read: () => Promise<T>) {
  const original = reader.query
  let claimed = false
  reader.query = new Proxy(original, { apply(target, client, args) {
    const statement = typeof args[0] === 'string' ? args[0] : args[0]?.text
    const pending = Reflect.apply(target, client, args)
    if (!claimed && typeof statement === 'string' && /^\s*(select|with)\b/i.test(statement) && statement.includes('coordinator_sessions')) {
      claimed = true
      assert.ok(pending instanceof Promise, 'the real PostgreSQL read uses its Promise result')
      return pending.then(async result => { await claim(); return result })
    }
    return pending
  } })
  try {
    const value = await read()
    assert.equal(claimed, true, 'the claim interleaved after the first session snapshot')
    return value
  } finally { reader.query = original }
}

dbTest('full and compact chat reads use one snapshot across a concurrent inbox claim', { timeout: 30_000 }, async t => {
  const [{ createRequestDatabaseScope, db, pool, withDatabaseClient }, schema, store, { userMessageEvent }, { chatFailure }, { eq, sql }] = snapshotRuntime!
  const scope = createRequestDatabaseScope(databaseUrl!)
  const owner = `test-chat-snapshot-${randomUUID()}`
  t.after(async () => {
    await scope.run(async () => {
      await db.delete(schema.bots).where(eq(schema.bots.ownerId, owner))
      await db.execute(sql`delete from "user" where id = ${owner}`)
    })
    await scope.close()
  })
  await scope.run(async () => {
    await db.execute(sql`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values (${owner}, 'Snapshot fixture', ${`${owner}@example.invalid`}, false, now(), now())`)
    const reader = await pool.connect(), writer = await pool.connect()
    try {
      for (const kind of ['full', 'compact'] as const) await t.test(kind, async () => {
        const botId = randomUUID(), holder = `wrun_snapshot_${kind}`
        await db.insert(schema.bots).values({ id: botId, ownerId: owner, workspaceId: await seedFixtureWorkspace(pool, owner), name: `Snapshot bot ${kind}` })
        // Insert only a durable pending event. The test owns the actual claim;
        // no unrelated background Workflow competes with this interleaving.
        await db.insert(schema.coordinatorEvents).values({ id: randomUUID(), ...userMessageEvent(owner, 'Snapshot request', { botId }) })
        const observed = await claimBetweenChatReads(reader,
          () => withDatabaseClient(writer, async () => {
            const taken = await store.takeInbox(owner, holder, botId)
            assert.deepEqual([taken.held, taken.added], [true, 1])
          }),
          () => withDatabaseClient(reader, async () => kind === 'full' ? await store.chatView(owner, 200, botId) : await store.chatVersion(owner, 200, botId)))
        assert.equal(observed.working, true, 'a pending request cannot appear failed while its claimed turn is running')
        assert.equal(observed.error, null)
        assert.equal(observed.cursor, 0, 'the state statement preceded the claim, so its messages and inbox share that snapshot')
        if ('items' in observed) {
          assert.equal(observed.items.at(-1)?.pending, true)
          assert.equal(chatFailure(observed), null, 'the mobile failure projection cannot invent an ended turn')
        }
        const current = await store.chatView(owner, 200, botId)
        assert.equal(current.cursor, 1)
        assert.equal(current.streamRunId, holder)
        assert.equal(current.working, true)
        assert.equal(chatFailure(current), null)
        await store.failTurn(owner, holder, 'model_tool_unavailable', botId)
        const failedFull = await store.chatView(owner, 200, botId), failedCompact = await store.chatVersion(owner, 200, botId)
        assert.deepEqual([failedFull.working, failedFull.error, failedCompact.working, failedCompact.error],
          [false, 'model_tool_unavailable', false, 'model_tool_unavailable'], 'a released lease must not nullify its session error in either snapshot reader')
        assert.equal(failedFull.streamRunId, undefined)
        assert.deepEqual(chatFailure(failedFull), { kind: 'failed', reason: 'tools', raw: 'model_tool_unavailable', failureDetails: failedFull.failureDetails })
        assert.equal(failedFull.failureDetails?.code, 'model_tool_unavailable')
      })
    } finally { reader.release(); writer.release() }
  })
})

dbTest('a continuation keeps the tail snapshot state after an earlier version read', { timeout: 30_000 }, async t => {
  const [{ createRequestDatabaseScope, db, pool, withDatabaseClient }, schema, store, { userMessageEvent }, { chatFailure }, { eq, sql }] = snapshotRuntime!
  const scope = createRequestDatabaseScope(databaseUrl!)
  const owner = `test-chat-tail-snapshot-${randomUUID()}`, botId = randomUUID(), holder = 'wrun_tail_snapshot'
  t.after(async () => {
    await scope.run(async () => {
      await db.delete(schema.bots).where(eq(schema.bots.ownerId, owner))
      await db.execute(sql`delete from "user" where id = ${owner}`)
    })
    await scope.close()
  })
  await scope.run(async () => {
    await db.execute(sql`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values (${owner}, 'Tail snapshot fixture', ${`${owner}@example.invalid`}, false, now(), now())`)
    await db.insert(schema.bots).values({ id: botId, ownerId: owner, workspaceId: await seedFixtureWorkspace(pool, owner), name: 'Tail snapshot bot' })
    await db.insert(schema.coordinatorMessages).values([
      { id: randomUUID(), userId: owner, botId, position: 1, message: { role: 'user', content: 'Earlier request' } },
      { id: randomUUID(), userId: owner, botId, position: 2, message: { role: 'assistant', content: 'Earlier reply' } },
    ])
    const previous = await store.chatView(owner, 200, botId)
    assert.equal(previous.working, false)
    const reader = await pool.connect(), writer = await pool.connect()
    try {
      const update = await claimBetweenChatReads(reader,
        () => withDatabaseClient(writer, async () => {
          await db.insert(schema.coordinatorEvents).values({ id: randomUUID(), ...userMessageEvent(owner, 'Next request', { botId }) })
          const taken = await store.takeInbox(owner, holder, botId)
          assert.deepEqual([taken.held, taken.added], [true, 1])
        }),
        () => withDatabaseClient(reader, () => store.chatUpdate(owner, botId, previous.continuation)))
      assert.ok('after' in update, 'the bounded continuation still uses a tail')
      assert.equal(update.items.at(-1)?.from, 'person')
      assert.equal(update.cursor, 3)
      assert.equal(update.working, true, 'an earlier idle version must not overwrite the newer claimed tail')
      assert.equal(update.streamRunId, holder)
      assert.equal(chatFailure(update), null)
    } finally { reader.release(); writer.release() }
  })
})

dbTest('the chat version changes exactly when the conversation or its inbox does, and costs a few bytes', async t => {
  const [{ createRequestDatabaseScope, db, pool }, schema, store, { recordCoordinatorEvent }, { userMessageEvent }, { and, eq, sql }] = await Promise.all([
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
    await db.insert(schema.bots).values([{ id: botId, ownerId: owner, workspaceId: await seedFixtureWorkspace(pool, owner), name: 'Version bot' }, { id: otherBot, ownerId: owner, workspaceId: await seedFixtureWorkspace(pool, owner), name: 'Other bot' }])
    const empty = await store.chatVersion(owner, 200, botId)
    assert.deepEqual({ ...empty, version: undefined }, { version: undefined, cursor: 0, working: false, error: null })

    await t.test('full and compact reads derive the same live deadline from their existing session and inbox', async () => {
      const leaseUntil = new Date(Date.now() + 300_000), wakeLeaseUntil = new Date(Date.now() + 120_000)
      const eventId = randomUUID()
      await db.insert(schema.coordinatorSessions).values({ userId: owner, botId, leaseHolder: 'fixture-live-lease', leaseUntil })
      await db.insert(schema.coordinatorEvents).values({ id: eventId, userId: owner, botId, kind: 'user_message', dedupeKey: `chat-live:${eventId}`, payload: { text: 'Live deadline fixture' }, wakeAttempts: 1, wakeLeaseUntil })
      try {
        const before = Date.now()
        const full = await store.chatViewState(owner, 200, botId)
        const version = await store.chatVersionState(owner, 200, botId)
        const expected = [leaseUntil.toISOString(), wakeLeaseUntil.toISOString()].sort()
        assert.deepEqual(full.expiries.map(date => date.toISOString()).sort(), expected)
        assert.deepEqual(version.expiries.map(date => date.toISOString()).sort(), expected)
        assert.ok(full.observedAt >= before && full.observedAt <= Date.now())
        assert.equal(full.chat.working, true)
        assert.equal('expiries' in await store.chatView(owner, 200, botId), false, 'ordinary/history callers retain the existing ChatView shape')
        await db.update(schema.coordinatorSessions).set({ leaseUntil: new Date(0) }).where(and(eq(schema.coordinatorSessions.userId, owner), eq(schema.coordinatorSessions.botId, botId)))
        await db.update(schema.coordinatorEvents).set({ tier: 'background' }).where(eq(schema.coordinatorEvents.id, eventId))
        assert.deepEqual((await store.chatViewState(owner, 200, botId)).expiries, [], 'expired leases and background inbox work do not schedule a read')
      } finally {
        await db.delete(schema.coordinatorEvents).where(eq(schema.coordinatorEvents.id, eventId))
        await db.delete(schema.coordinatorSessions).where(and(eq(schema.coordinatorSessions.userId, owner), eq(schema.coordinatorSessions.botId, botId)))
      }
    })

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

    const cold = await measured(() => store.chatView(owner, 200, botId))
    const previous = cold.value
    const legacyReload = await measured(() => store.chatView(owner, 200, botId))
    const warm = await measured(async () => ({ unchanged: true, ...await store.chatVersion(owner, 200, botId) }))
    const restored = await measured(() => store.chatUpdate(owner, botId, previous.continuation))
    assert.ok('after' in restored.value)
    assert.deepEqual(mergeChat(previous, restored.value)?.items, previous.items)
    await db.insert(schema.coordinatorMessages).values([
      { id: randomUUID(), userId: owner, botId, position: 41, message: { role: 'user', content: 'Next question' } },
      { id: randomUUID(), userId: owner, botId, position: 42, message: { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'delta-tool', toolName: 'read_file', input: { path: 'fixture' } }] } },
      { id: randomUUID(), userId: owner, botId, position: 43, message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'delta-tool', toolName: 'read_file', output: { type: 'text', value: 'read' } }] } },
      { id: randomUUID(), userId: owner, botId, position: 44, message: { role: 'assistant', content: 'The new answer' } },
    ])
    const deltaRead = await measured(() => store.chatUpdate(owner, botId, previous.continuation))
    const delta = deltaRead.value
    assert.ok('after' in delta, 'an append reads only the overlapping tail')
    const complete = await store.chatView(owner, 200, botId)
    assert.deepEqual(mergeChat(previous, delta)?.items, complete.items, 'pending input and tool-result grouping match a full read')
    const deltaBytes = Buffer.byteLength(JSON.stringify(delta))
    t.diagnostic(JSON.stringify({ event: 'chat_delta_bytes', full: Buffer.byteLength(JSON.stringify(complete)), delta: deltaBytes }))
    assert.ok(deltaBytes * 10 < Buffer.byteLength(JSON.stringify(complete)))

    await db.update(schema.coordinatorMessages).set({ message: { role: 'assistant', content: 'Earlier reply was corrected' } }).where(and(eq(schema.coordinatorMessages.userId, owner), eq(schema.coordinatorMessages.botId, botId), eq(schema.coordinatorMessages.position, 2)))
    assert.ok(!('after' in await store.chatUpdate(owner, botId, complete.continuation)), 'rewriting an older message invalidates the prefix proof')
    assert.ok(!('after' in await store.chatUpdate(owner, otherBot, complete.continuation)), 'another bot cannot reuse this prefix')

    const beforeDelete = await store.chatView(owner, 200, botId)
    await db.delete(schema.coordinatorMessages).where(and(eq(schema.coordinatorMessages.userId, owner), eq(schema.coordinatorMessages.botId, botId), eq(schema.coordinatorMessages.position, 1)))
    const deletion = await measured(() => store.chatUpdate(owner, botId, beforeDelete.continuation))
    assert.ok(!('after' in deletion.value), 'deleting a cached prefix row invalidates its proof')
    const deleted = mergeChat(beforeDelete, deletion.value)
    assert.ok(deleted)
    assert.ok(!deleted.items.some(item => item.position === 1))
    t.diagnostic(JSON.stringify({ event: 'read_cache_measurement', surface: 'bot-chat-store', scope: 'data-read-path_not_page_http', fixtureMessages: 40,
      legacyReload: readMetrics(legacyReload), cold: readMetrics(cold), warmKnown: readMetrics(warm), reloadRestored: readMetrics(restored), appendedTurnDelta: readMetrics(deltaRead), deletion: readMetrics(deletion) }))

    await db.insert(schema.coordinatorMessages).values(Array.from({ length: 210 }, (_, index) => ({ id: randomUUID(), userId: owner, botId, position: 45 + index, message: { role: 'user', content: `Long absence ${index}` } })))
    const resumed = await store.chatUpdate(owner, botId, complete.continuation)
    assert.ok(!('after' in resumed), 'more than a window of new messages must resnapshot rather than skip a gap')
    assert.ok(resumed.historyBefore)
    const through = resumed.items[1].position - 1
    const older = await store.chatView(owner, 200, botId, { through })
    assert.ok(older.items[0].position < resumed.items[0].position, 'older messages are fetched only on request')
    const paged = [...older.items, ...resumed.items.filter(item => item.pending || item.position > through)]
    assert.equal(new Set(paged.map(item => item.position)).size, paged.length, 'overlapping pages contain no duplicate rows')
    assert.ok(!older.items.some(item => item.pending), 'historical pages never repeat the current inbox')
  })
})

dbTest('a disk-restored tool chat repairs its proven prefix without returning cached bodies from PostgreSQL', async t => {
  const [{ createRequestDatabaseScope, db, pool }, schema, store, { and, eq, sql }] = await Promise.all([
    import('../db'), import('../db/schema'), import('./store'), import('drizzle-orm'),
  ])
  const scope = createRequestDatabaseScope(databaseUrl!)
  const owner = `test-chat-metadata-${randomUUID()}`, botId = randomUUID(), otherBot = randomUUID()
  const mine = and(eq(schema.coordinatorMessages.userId, owner), eq(schema.coordinatorMessages.botId, botId))
  t.after(async () => {
    await scope.run(async () => {
      await db.delete(schema.coordinatorMessages).where(eq(schema.coordinatorMessages.userId, owner))
      await db.delete(schema.bots).where(eq(schema.bots.ownerId, owner))
      await db.execute(sql`delete from "user" where id = ${owner}`)
    })
    await scope.close()
  })
  await scope.run(async () => {
    // Disposable setup is outside measured reads. No model work is started.
    await db.execute(sql`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values (${owner}, 'Metadata fixture', ${`${owner}@example.invalid`}, false, now(), now())`)
    await db.insert(schema.bots).values([{ id: botId, ownerId: owner, workspaceId: await seedFixtureWorkspace(pool, owner), name: 'Metadata bot' }, { id: otherBot, ownerId: owner, workspaceId: await seedFixtureWorkspace(pool, owner), name: 'Other bot' }])
    const body = 'BODY_MUST_NOT_REPLAY_FROM_PREFIX '.repeat(150)
    const messages: Record<string, unknown>[] = Array.from({ length: 40 }, (_, index) => index % 2
      ? { role: 'assistant', content: body + index } : { role: 'user', content: `Question ${index}` })
    const call = (id: string, target: string) => ({ type: 'tool-call', toolCallId: id, toolName: 'github_call', input: { name: 'get_issue', arguments: { path: target, privatePayload: 'INPUT_MUST_STAY_IN_DB'.repeat(100) } } })
    const receipt = (id: string, failed = false) => ({ type: 'tool-result', toolCallId: id, toolName: 'github_call', output: { type: 'json', value: { ...(failed ? { error: { code: 'access_denied', detail: 'workspace_mismatch' } } : { ok: true }), rows: 'OUTPUT_MUST_STAY_IN_DB'.repeat(100) } } })
    messages[1] = { role: 'assistant', content: [{ type: 'text', text: body }, call('same-call', 'first/private/path'), { type: 'tool-call', toolCallId: 'hidden-call', toolName: 'list_agents', input: {} }] }
    messages[2] = { role: 'tool', content: [receipt('same-call', true)] }
    messages[3] = { role: 'assistant', content: [call('next-call', 'second/private/path')] }
    messages[4] = { role: 'tool', content: [receipt('next-call')] }
    messages[7] = { role: 'assistant', content: [call('same-call', 'another/reply/path')] }
    messages[8] = { role: 'tool', content: [receipt('same-call')] }
    await db.insert(schema.coordinatorMessages).values(messages.map((message, index) => ({ id: randomUUID(), userId: owner, botId, position: index + 1, message })))

    const cold = await measured(() => store.chatView(owner, 200, botId))
    const legacyReload = await measured(() => store.chatView(owner, 200, botId))
    const previous = cold.value
    assert.ok(previous.continuation)
    const restored = persistentReadData(['coordinator-chat', botId], previous) as ChatView
    assert.equal(restored.restoreToolMetadata, true)
    assert.deepEqual(restored.continuation, previous.continuation)
    for (const privateValue of ['first/private/path', 'another/reply/path', 'access_denied']) assert.equal(JSON.stringify(restored).includes(privateValue), false)
    const warmKnown = await measured(async () => ({ unchanged: true, ...await store.chatVersion(owner, 200, botId) }))
    const normalTail = await measured(() => store.chatUpdate(owner, botId, previous.continuation))
    const proof = { ...previous.continuation, restoreToolMetadata: true as const }
    const reloadRestored = await measured(() => store.chatUpdate(owner, botId, proof))
    assert.ok('after' in reloadRestored.value)
    assert.ok(reloadRestored.value.toolMetadata)
    assert.equal(reloadRestored.value.toolMetadata.rows.length, 6)
    assert.equal(reloadRestored.statements, normalTail.statements, 'prefix metadata shares the existing hash statement')
    const metadataJson = JSON.stringify(reloadRestored.value.toolMetadata)
    for (const forbidden of ['BODY_MUST_NOT_REPLAY', 'INPUT_MUST_STAY_IN_DB', 'OUTPUT_MUST_STAY_IN_DB', 'inputPreview', 'outputPreview', 'quotePreview', 'list_agents']) assert.equal(metadataJson.includes(forbidden), false)
    assert.ok(reloadRestored.resultBytes * 5 < cold.resultBytes, 'database egress includes only the tail and bounded display metadata')
    assert.ok(reloadRestored.responseBytes * 5 < cold.responseBytes, 'the response does not retransmit cached prefix bodies')
    const merged = mergeChat(restored, reloadRestored.value)
    assert.ok(merged)
    const visible = (view: ChatView) => view.items.map(item => ({ position: item.position, text: item.text, tools: item.activity?.tools.map(({ call, name, state, at, target, displayName, errorCode, errorDetail }) => ({ call, name, state, at, target, displayName, errorCode, errorDetail })) }))
    assert.deepEqual(visible(merged), visible(previous), 'cross-row replies and repeated ids in separate replies restore exact UI metadata')
    assert.equal('toolMetadata' in merged, false)
    assert.equal('restoreToolMetadata' in merged, false)
    assert.equal('toolMetadata' in (persistentReadData(['coordinator-chat', botId], reloadRestored.value) as object), false, 'even an unconsumed response cannot persist its overlay')
    assert.ok(!('after' in await store.chatUpdate(owner, otherBot, proof)), 'proofs cannot restore another bot')

    await db.insert(schema.coordinatorMessages).values([
      { id: randomUUID(), userId: owner, botId, position: 41, message: { role: 'user', content: 'Next question' } },
      { id: randomUUID(), userId: owner, botId, position: 42, message: { role: 'assistant', content: [call('new-call', 'new/path')] } },
      { id: randomUUID(), userId: owner, botId, position: 43, message: { role: 'tool', content: [receipt('new-call')] } },
      { id: randomUUID(), userId: owner, botId, position: 44, message: { role: 'assistant', content: 'New answer' } },
    ])
    const appended = await measured(() => store.chatUpdate(owner, botId, merged.continuation))
    assert.ok('after' in appended.value)
    assert.equal(appended.value.toolMetadata, undefined, 'subsequent in-memory reads do not repeat the prefix metadata')
    const appendedMerge = mergeChat(merged, appended.value)
    assert.ok(appendedMerge)
    assert.deepEqual(visible(appendedMerge), visible(await store.chatView(owner, 200, botId)))

    await db.update(schema.coordinatorMessages).set({ message: { role: 'assistant', content: [call('same-call', 'edited/path')] } }).where(and(mine, eq(schema.coordinatorMessages.position, 2)))
    const edited = await measured(() => store.chatUpdate(owner, botId, proof))
    assert.ok(!('after' in edited.value))
    assert.equal(edited.value.toolMetadata, undefined, 'editing a proven prefix returns a complete snapshot, never an overlay')
    assert.ok(edited.value.continuation)
    await db.delete(schema.coordinatorMessages).where(and(mine, eq(schema.coordinatorMessages.position, 8)))
    const deleted = await measured(() => store.chatUpdate(owner, botId, { ...edited.value.continuation!, restoreToolMetadata: true }))
    assert.ok(!('after' in deleted.value))
    assert.ok(!deleted.value.items.some(item => item.position === 8))
    assert.equal(deleted.value.toolMetadata, undefined)
    t.diagnostic(JSON.stringify({ event: 'read_cache_measurement', surface: 'bot-chat-tool-metadata', scope: 'data-read-path_not_page_http', fixtureMessages: messages.length,
      legacyReload: readMetrics(legacyReload), cold: readMetrics(cold), warmKnown: readMetrics(warmKnown), normalTail: readMetrics(normalTail), reloadRestored: readMetrics(reloadRestored), appendedTurnDelta: readMetrics(appended), prefixEdit: readMetrics(edited), deletion: readMetrics(deleted) }))
    assert.ok(deleted.value.continuation)
    const lastProof = { ...deleted.value.continuation, restoreToolMetadata: true as const }
    assert.ok(!('after' in await store.chatUpdate(owner, botId, { ...lastProof, cursor: 999 })), 'a cursor ahead of the stored chat still resets')
    await db.insert(schema.coordinatorMessages).values(Array.from({ length: 210 }, (_, index) => ({ id: randomUUID(), userId: owner, botId, position: 45 + index, message: { role: 'user', content: `Reconnect ${index}` } })))
    const resumed = await store.chatUpdate(owner, botId, lastProof)
    assert.ok(!('after' in resumed), 'a valid prefix cannot skip more than a window of appended messages')
    assert.equal(resumed.toolMetadata, undefined)
  })
})
