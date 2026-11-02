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

const runId = randomUUID()
const thinking = 'Weighing which thread fits. '.repeat(400)
const bigOutput = { type: 'json', value: { rows: Array.from({ length: 300 }, (_, i) => ({ i, title: `Issue number ${i} with a long title` })) } }
/** The shapes stored turns have in production (AI SDK model messages plus Mikka fields). */
function conversation(): Record<string, unknown>[] {
  return [
    { role: 'user', content: 'Fix the login bug and tell me when it is done' },
    { role: 'assistant', mikkaStreamId: 'stream-1', content: [
      { type: 'reasoning', text: thinking },
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'list_issues', input: { query: 'login '.repeat(100) } },
      { type: 'tool-call', toolCallId: 'call-2', toolName: 'dispatch_run', input: { issueId: randomUUID(), prompt: 'Fix login' } },
    ] },
    { role: 'tool', content: [
      { type: 'tool-result', toolCallId: 'call-1', toolName: 'list_issues', output: bigOutput },
      { type: 'tool-result', toolCallId: 'call-2', toolName: 'dispatch_run', output: { type: 'json', value: { runId, status: 'queued', detail: 'x'.repeat(2000) } } },
    ] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-3', toolName: 'read_file', output: { type: 'error-text', value: 'ENOENT: '.repeat(100) } }] },
    { role: 'assistant', mikkaStreamId: 'stream-1', content: [{ type: 'reasoning', text: 'Done.' }, { type: 'text', text: `Started a thread [[run:${runId}]].` }] },
    { role: 'user', content: [{ type: 'text', text: 'Here is a screenshot' }, { type: 'file', mediaType: 'image/png', data: 'iVBORw0KGgo'.repeat(500) }] },
    { role: 'assistant', mikkaStopped: true, content: 'Stopped here.' },
  ]
}

dbTest('the chat reads compact parts and shows exactly what the full messages show', async t => {
  const [{ createRequestDatabaseScope, db }, schema, store, { chatItems }, { compactChatMessage, TOOL_PREVIEW_CHARS }, { asc, eq, and, sql }] = await Promise.all([
    import('../db'), import('../db/schema'), import('./store'), import('./context'), import('./chat-projection'), import('drizzle-orm'),
  ])
  const scope = createRequestDatabaseScope(databaseUrl!)
  const owner = `test-chat-projection-${randomUUID()}`, botId = randomUUID()
  t.after(async () => {
    await scope.run(async () => {
      await db.delete(schema.coordinatorMessages).where(eq(schema.coordinatorMessages.userId, owner))
      await db.delete(schema.bots).where(eq(schema.bots.id, botId))
      await db.execute(sql`delete from "user" where id = ${owner}`)
    })
    await scope.close()
  })
  await scope.run(async () => {
    await db.execute(sql`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values (${owner}, 'Projection fixture', ${`${owner}@example.invalid`}, false, now(), now())`)
    await db.insert(schema.bots).values({ id: botId, ownerId: owner, workspaceId: randomUUID(), name: 'Projection bot' })
    const stored = conversation()
    await db.insert(schema.coordinatorMessages).values(stored.map((message, index) => ({ id: randomUUID(), userId: owner, botId, position: index + 1, message })))
    const mine = and(eq(schema.coordinatorMessages.userId, owner), eq(schema.coordinatorMessages.botId, botId))

    const full = await db.select({ id: schema.coordinatorMessages.id, position: schema.coordinatorMessages.position, message: schema.coordinatorMessages.message, createdAt: schema.coordinatorMessages.createdAt })
      .from(schema.coordinatorMessages).where(mine).orderBy(asc(schema.coordinatorMessages.position))
    const view = await store.chatView(owner, 200, botId)
    assert.deepEqual(view.items, chatItems(full as never), 'the chat items are the same as from the full messages')
    assert.deepEqual(view.persistedStreamIds, ['stream-1'])
    assert.ok(view.items.some(item => item.threads.includes(runId)), 'the dispatched thread still shows')

    const compact = (await db.select({ message: compactChatMessage }).from(schema.coordinatorMessages).where(mine).orderBy(asc(schema.coordinatorMessages.position))).map(row => row.message)
    const calls = compact[1].content as { inputPreview: string }[]
    assert.equal(calls[1].inputPreview.length, TOOL_PREVIEW_CHARS)
    assert.match(calls[1].inputPreview, /^\{"query": "login login/, 'the input preview is the start of the input as JSON text')
    assert.deepEqual(compact[1], { role: 'assistant', mikkaStreamId: 'stream-1', content: [
      { type: 'reasoning', chars: thinking.length },
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'list_issues', inputPreview: calls[1].inputPreview },
      { type: 'tool-call', toolCallId: 'call-2', toolName: 'dispatch_run', inputPreview: calls[2].inputPreview },
    ] })
    const results = compact[2].content as Record<string, unknown>[]
    assert.equal((results[0].outputPreview as string).length, TOOL_PREVIEW_CHARS)
    assert.deepEqual({ ...results[0], outputPreview: undefined }, { type: 'tool-result', toolCallId: 'call-1', toolName: 'list_issues', status: 'done', outputPreview: undefined })
    assert.deepEqual(results[1].output, { type: 'json', value: { runId } }, 'only the dispatched run id is kept of a dispatch result')
    assert.equal((compact[3].content as Record<string, unknown>[])[0].status, 'error')
    assert.deepEqual((compact[5].content as unknown[])[1], { type: 'file', mediaType: 'image/png' })
    // The chat keys a streamed reply and its stored row by mikkaStreamId (ChatItem.streamId): every row keeps it.
    assert.deepEqual(compact.map(message => message.mikkaStreamId), stored.map(message => message.mikkaStreamId))
    assert.deepEqual(compact[0], stored[0], 'a plain message is unchanged')
    assert.deepEqual(compact[6], stored[6])

    // What leaves the database per read: the full rows against the compact ones.
    const [bytes] = (await db.execute(sql`select sum(octet_length(${schema.coordinatorMessages.message}::text))::int as full, sum(octet_length((${compactChatMessage})::text))::int as compact
      from ${schema.coordinatorMessages} where ${mine}`)).rows as { full: number; compact: number }[]
    t.diagnostic(JSON.stringify({ event: 'chat_read_bytes', ...bytes }))
    assert.ok(bytes.compact * 10 < bytes.full, `compact ${bytes.compact} bytes, full ${bytes.full}`)
  })
})
