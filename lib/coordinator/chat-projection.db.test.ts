import { seedFixtureWorkspace } from '../../tests/helpers/task-workspace'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { ModelMessage } from 'ai'
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
const note = 'Fix the login redirect and add a regression test. '.repeat(30).trim()
const bigOutput = { type: 'json', value: { rows: Array.from({ length: 300 }, (_, i) => ({ i, title: `Issue number ${i} with a long title` })) } }
/** The shapes stored turns have in production (AI SDK model messages plus Mikka fields). */
function conversation(): Record<string, unknown>[] {
  return [
    { role: 'user', content: 'Fix the login bug and tell me when it is done' },
    { role: 'assistant', mikkaStreamId: 'stream-1', content: [
      { type: 'reasoning', text: thinking },
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'list_issues', input: { query: 'login '.repeat(100) } },
      { type: 'tool-call', toolCallId: 'call-2', toolName: 'dispatch_run', input: { issueId: randomUUID(), note } },
    ] },
    { role: 'tool', content: [
      { type: 'tool-result', toolCallId: 'call-1', toolName: 'list_issues', output: bigOutput },
      { type: 'tool-result', toolCallId: 'call-2', toolName: 'dispatch_run', output: { type: 'json', value: { runId, status: 'queued', detail: 'x'.repeat(2000) } } },
    ] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-3', toolName: 'read_file', output: { type: 'error-text', value: 'ENOENT: '.repeat(100) } }] },
    { role: 'assistant', mikkaStreamId: 'stream-1', content: [{ type: 'reasoning', text: 'Done.' }, { type: 'text', text: `Started a thread [[run:${runId}]].` }] },
    { role: 'user', content: [{ type: 'text', text: 'Here is a screenshot' }, { type: 'file', mediaType: 'image/png', data: 'iVBORw0KGgo'.repeat(500) }] },
    { role: 'assistant', mikkaStopped: true, content: 'Stopped here.' },
    // Edge whitespace the SQL must trim as the chat does: a newline-led long note keeps its ellipsis; a note of only a
    // newline falls through to the prompt.
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-4', toolName: 'dispatch_run', input: { note: `\n${'y'.repeat(1500)}` } }] },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-5', toolName: 'dispatch_run', input: { note: '\n', prompt: 'Use the prompt' } }] },
    { role: 'user', content: '[Welcome] Synthetic welcome' },
    // Production SDK response.messages omit invalid:true; the paired error is
    // the legacy evidence. Keep it in storage, never in the public preview.
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'invalid-legacy', toolName: 'none', input: { x: 1 } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'invalid-legacy', toolName: 'none', output: { type: 'error-text', value: 'AI_NoSuchToolError: private synthetic SDK error' } }] },
    { role: 'assistant', content: 'A corrected welcome' },
  ]
}

dbTest('the chat reads compact parts and shows exactly what the full messages show', async t => {
  const [{ createRequestDatabaseScope, db, pool }, schema, store, { chatItems, QUOTE_PREVIEW_CHARS }, { compactChatMessage, compactChatToolMetadata, TOOL_PREVIEW_CHARS }, { asc, eq, and, sql }] = await Promise.all([
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
    await db.insert(schema.bots).values({ id: botId, ownerId: owner, workspaceId: await seedFixtureWorkspace(pool, owner), name: 'Projection bot' })
    const stored = conversation()
    await db.insert(schema.coordinatorMessages).values(stored.map((message, index) => ({ id: randomUUID(), userId: owner, botId, position: index + 1, message })))
    const mine = and(eq(schema.coordinatorMessages.userId, owner), eq(schema.coordinatorMessages.botId, botId))

    const full = await db.select({ id: schema.coordinatorMessages.id, position: schema.coordinatorMessages.position, message: schema.coordinatorMessages.message, createdAt: schema.coordinatorMessages.createdAt })
      .from(schema.coordinatorMessages).where(mine).orderBy(asc(schema.coordinatorMessages.position))
    const view = await store.chatView(owner, 200, botId)
    assert.deepEqual(view.items, chatItems(full as never), 'the chat items are the same as from the full messages')
    assert.doesNotMatch(JSON.stringify(view.items),/NoSuchToolError|private synthetic SDK error|"none"/)
    assert.deepEqual(view.persistedStreamIds, ['stream-1'])
    assert.ok(view.items.some(item => item.threads.includes(runId)), 'the dispatched thread still shows')
    assert.ok(view.items.some(item => item.activity?.tools.some(tool => tool.quote === `${note.slice(0, QUOTE_PREVIEW_CHARS).trimEnd()}…`)), 'the chat shows the note to its limit, then an ellipsis')
    const quotes = Object.fromEntries(view.items.flatMap(item => item.activity?.tools ?? []).map(tool => [tool.call, tool.quote]))
    assert.equal(quotes['call-4'], `${'y'.repeat(QUOTE_PREVIEW_CHARS)}…`, 'a newline-led note is trimmed, then cut with its ellipsis')
    assert.equal(quotes['call-5'], 'Use the prompt', 'a note of only whitespace gives way to the prompt')

    const compact = (await db.select({ message: compactChatMessage }).from(schema.coordinatorMessages).where(mine).orderBy(asc(schema.coordinatorMessages.position))).map(row => row.message)
    assert.doesNotMatch(JSON.stringify(compact),/NoSuchToolError|private synthetic SDK error/,'SDK error text never crosses the SQL projection')
    assert.ok(JSON.stringify(full).includes('NoSuchToolError'),'original evidence remains stored')
    const metadata = await db.select({ parts: compactChatToolMetadata }).from(schema.coordinatorMessages).where(mine)
    assert.equal(metadata.flatMap(row=>row.parts).filter(part=>part.mikkaInvalidToolCall).length,1,'legacy result also invalidates a pre-fix cached activity')
    const calls = compact[1].content as { inputPreview: string }[]
    assert.equal(calls[1].inputPreview.length, TOOL_PREVIEW_CHARS)
    assert.match(calls[1].inputPreview, /^\{"query": "login login/, 'the input preview is the start of the input as JSON text')
    assert.deepEqual(compact[1], { role: 'assistant', mikkaStreamId: 'stream-1', content: [
      { type: 'reasoning', chars: thinking.length },
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'list_issues', inputPreview: calls[1].inputPreview, target: 'login '.repeat(100).trim().slice(0, 161) },
      { type: 'tool-call', toolCallId: 'call-2', toolName: 'dispatch_run', inputPreview: calls[2].inputPreview, quotePreview: note.slice(0, QUOTE_PREVIEW_CHARS + 1) },
    ] })
    assert.ok(calls[2].inputPreview.startsWith('{"note": '), 'the note leads the cut input preview; the quote carries it apart')
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
    // A call's quote is sent on purpose, capped per call; everything else stays a tenth of the full rows.
    const [bytes] = (await db.execute(sql`select sum(octet_length(${schema.coordinatorMessages.message}::text))::int as full, sum(octet_length((${compactChatMessage})::text))::int as compact
      from ${schema.coordinatorMessages} where ${mine}`)).rows as { full: number; compact: number }[]
    const quoted = compact.flatMap(message => Array.isArray(message.content) ? message.content as { quotePreview?: string }[] : []).map(part => part.quotePreview ?? '')
    const quoteBytes = quoted.reduce((sum, quote) => sum + Buffer.byteLength(JSON.stringify(quote)), 0)
    t.diagnostic(JSON.stringify({ event: 'chat_read_bytes', ...bytes, quotes: quoteBytes }))
    assert.ok((bytes.compact - quoteBytes) * 10 < bytes.full, `compact ${bytes.compact} bytes (${quoteBytes} of them quotes), full ${bytes.full}`)
    const longest = Math.max(...quoted.map(quote => quote.length))
    assert.ok(longest <= QUOTE_PREVIEW_CHARS + 1, `a quote is capped: ${longest} characters`)
  })
})


dbTest('exhausted recovery saves completed receipts once, keeps evidence and releases the failed lease atomically', async t => {
  const [{ createRequestDatabaseScope, db, pool }, schema, store, { asc, eq, and, sql }] = await Promise.all([
    import('../db'), import('../db/schema'), import('./store'), import('drizzle-orm'),
  ])
  const scope = createRequestDatabaseScope(databaseUrl!)
  const owner = `test-tool-recovery-${randomUUID()}`, botId = randomUUID(), holder = 'wrun_tool-recovery-fixture'
  t.after(async () => {
    await scope.run(async () => {
      await db.delete(schema.coordinatorMessages).where(eq(schema.coordinatorMessages.userId, owner))
      await db.delete(schema.coordinatorSessions).where(eq(schema.coordinatorSessions.userId, owner))
      await db.delete(schema.bots).where(eq(schema.bots.id, botId))
      await db.execute(sql`delete from "user" where id = ${owner}`)
    })
    await scope.close()
  })
  await scope.run(async () => {
    await db.execute(sql`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values (${owner}, 'Recovery fixture', ${`${owner}@example.invalid`}, false, now(), now())`)
    await db.insert(schema.bots).values({ id: botId, ownerId: owner, workspaceId: await seedFixtureWorkspace(pool, owner), name: 'Recovery bot' })
    await db.insert(schema.coordinatorMessages).values({ id: randomUUID(), userId: owner, botId, position: 1, message: { role: 'user', content: 'Synthetic request' } })
    await db.insert(schema.coordinatorSessions).values({ userId: owner, botId, leaseHolder: holder, leaseUntil: new Date(Date.now() + 60_000) })
    const messages: ModelMessage[] = [
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'done', toolName: 'list_issues', input: {} }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'done', toolName: 'list_issues', output: { type: 'json', value: { receipt: 'completed-once' } } }] },
      ...[1, 2].flatMap(index => [
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `invalid-${index}`, toolName: 'none', input: { x: index } }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: `invalid-${index}`, toolName: 'none', output: { type: 'error-text', value: 'AI_NoSuchToolError: synthetic raw evidence' } }] },
      ] as ModelMessage[]),
    ]
    const completed = { messages, streamId: `${holder}:0` }
    await store.failTurn(owner, holder, 'model_tool_unavailable', botId, completed)
    await store.failTurn(owner, holder, 'model_tool_unavailable', botId, completed)
    const mine = and(eq(schema.coordinatorMessages.userId, owner), eq(schema.coordinatorMessages.botId, botId))
    const rows = await db.select({ message: schema.coordinatorMessages.message }).from(schema.coordinatorMessages).where(mine).orderBy(asc(schema.coordinatorMessages.position))
    assert.equal(rows.length, 7, 'replaying the failure step cannot append receipts twice')
    assert.equal((rows[0].message as Record<string, unknown>).mikkaFailure, 'model_tool_unavailable')
    assert.deepEqual(rows.slice(1).map(row => {
      const { mikkaStreamId: _stream, ...message } = row.message as Record<string, unknown>
      return message
    }), messages, 'valid receipts and the original invalid call/result evidence are saved exactly once')
    const [session] = await db.select({ holder: schema.coordinatorSessions.leaseHolder, until: schema.coordinatorSessions.leaseUntil, error: schema.coordinatorSessions.lastError }).from(schema.coordinatorSessions)
      .where(and(eq(schema.coordinatorSessions.userId, owner), eq(schema.coordinatorSessions.botId, botId)))
    assert.deepEqual(session, { holder: null, until: null, error: 'model_tool_unavailable' })
    const view = await store.chatView(owner, 200, botId)
    assert.equal(view.working, false)
    assert.equal(view.error, 'model_tool_unavailable')
    const tools = view.items.flatMap(item => item.activity?.tools ?? [])
    assert.deepEqual(tools.map(tool => ({ name: tool.name, state: tool.state })), [{ name: 'list_issues', state: 'done' }])
    assert.doesNotMatch(JSON.stringify(view.items), /NoSuchToolError|synthetic raw evidence|"none"/)
  })
})

dbTest('real tool failures and bounded full-input metadata survive the database projection', async t => {
  const [{ createRequestDatabaseScope, db, pool }, schema, { createCoordinatorRegistry }, { chatItems }, { compactChatMessage }, { asc, eq, and, sql }] = await Promise.all([
    import('../db'), import('../db/schema'), import('../../workflows/coordinator/tools'), import('./context'), import('./chat-projection'), import('drizzle-orm'),
  ])
  const scope = createRequestDatabaseScope(databaseUrl!)
  const owner = `test-tool-metadata-${randomUUID()}`, botId = randomUUID()
  t.after(async () => {
    await scope.run(async () => {
      await db.delete(schema.coordinatorMessages).where(eq(schema.coordinatorMessages.userId, owner))
      await db.delete(schema.bots).where(eq(schema.bots.id, botId))
      await db.execute(sql`delete from "user" where id = ${owner}`)
    })
    await scope.close()
  })
  await scope.run(async () => {
    await db.execute(sql`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values (${owner}, 'Tool metadata fixture', ${`${owner}@example.invalid`}, false, now(), now())`)
    await db.insert(schema.bots).values({ id: botId, ownerId: owner, workspaceId: await seedFixtureWorkspace(pool, owner), name: 'Metadata bot' })
    // Execute the actual registered read tool against this isolated PostgreSQL,
    // then pass its receipt through the persisted chat contract. No provider stub.
    const registry = createCoordinatorRegistry(owner, botId, undefined, { switches: { issueTools: true, factoryRouting: true, factoryLifecycle: true } })
    const execute = registry.get_factory_task.execute as unknown as (input: { taskId: string }, options: { toolCallId: string; messages: [] }) => Promise<unknown>
    const failure = await execute({ taskId: randomUUID() }, { toolCallId: 'factory', messages: [] })
    assert.deepEqual(failure, { error: 'factoryNotFound' })
    const padding = 'p'.repeat(350)
    const cases = [
      { name: 'get_factory_task', input: { a: padding, title: 'ALEX-45' }, value: { a: padding, ...(failure as object) }, code: 'factoryNotFound', target: 'ALEX-45' },
      { name: 'dispatch_run', input: {}, value: { a: padding, ok: false, code: 'worker_spawn_failed', detail: 'cli_not_installed' }, code: 'worker_spawn_failed', detail: 'cli_not_installed' },
      { name: 'github_call', input: { name: 'pull_request_read', arguments: { a: padding, owner: 'alexj11324', repo: 'Mikka' } }, value: { isError: true, structuredContent: { error: 'repositoryNotFound', detail: 'not_visible_to_token' } }, code: 'repositoryNotFound', detail: 'not_visible_to_token', target: 'alexj11324/Mikka', displayName: 'GitHub · Pull request read' },
      { name: 'call_personal_mcp_tool', input: { name: 'search_pages', arguments: { a: padding, query: ' \n  决定🗺️ '.repeat(50) } }, value: { rows: [] }, target: Array.from('决定🗺️ '.repeat(50).trim()).slice(0, 159).join('') + '…', displayName: 'MCP · Search pages' },
      { name: 'call_app_tool', input: { tool: 'GMAIL_SEARCH_MESSAGES', arguments: { q: ' \t from:alex@example.invalid \n' } }, value: {}, target: 'from:alex@example.invalid', displayName: 'Gmail search messages' },
      { name: 'list_issues', input: {}, value: { items: [{ error: 'notFound', ok: false }] } },
      { name: 'list_issues', input: {}, value: { error: '' } },
      { name: 'list_issues', input: {}, value: { error: false } },
      { name: 'list_issues', input: {}, value: { error: null } },
      { name: 'dispatch_run', input: {}, value: 'worker_spawn_failed (cli_not_installed)', type: 'error-text', code: 'worker_spawn_failed', detail: 'cli_not_installed' },
      // Unknown provider prose stays a failure without inventing an error code.
      { name: 'read_file', input: {}, value: 'The provider could not read the file.', type: 'error-text', failed: true },
      { name: 'read_file', input: {}, value: { error: 'notFound\n' }, failed: true },
      { name: 'read_file', input: {}, value: { error: { code: 'permissionDenied', detail: 'repository_scope' } }, code: 'permissionDenied', detail: 'repository_scope' },
    ]
    const messages = [
      { role: 'assistant', content: cases.map((entry, index) => ({ type: 'tool-call', toolCallId: `call-${index}`, toolName: entry.name, input: entry.input })) },
      { role: 'tool', content: cases.map((entry, index) => ({ type: 'tool-result', toolCallId: `call-${index}`, toolName: entry.name, output: { type: entry.type ?? 'json', value: entry.value } })) },
    ]
    await db.insert(schema.coordinatorMessages).values(messages.map((message, index) => ({ id: randomUUID(), userId: owner, botId, position: index + 1, message })))
    const mine = and(eq(schema.coordinatorMessages.userId, owner), eq(schema.coordinatorMessages.botId, botId))
    const selected = { position: schema.coordinatorMessages.position, createdAt: schema.coordinatorMessages.createdAt }
    const full = await db.select({ ...selected, message: schema.coordinatorMessages.message }).from(schema.coordinatorMessages).where(mine).orderBy(asc(schema.coordinatorMessages.position))
    const compact = await db.select({ ...selected, message: compactChatMessage }).from(schema.coordinatorMessages).where(mine).orderBy(asc(schema.coordinatorMessages.position))
    const tools = chatItems(compact as never)[0].activity!.tools
    assert.deepEqual(tools, chatItems(full as never)[0].activity!.tools, 'full and SQL-projected messages expose identical tool metadata')
    for (const [index, entry] of cases.entries()) {
      assert.equal(tools[index].state, entry.code || entry.failed ? 'error' : 'done', `case ${index} state`)
      assert.equal(tools[index].errorCode, entry.code, `case ${index} code`)
      assert.equal(tools[index].errorDetail, entry.detail, `case ${index} detail`)
      assert.equal(tools[index].target, entry.target, `case ${index} target`)
      if (entry.displayName) assert.equal(tools[index].displayName, entry.displayName)
      if (tools[index].target) assert.ok(Array.from(tools[index].target!).length <= 160)
      assert.ok(Array.from(tools[index].displayName!).length <= 128)
    }
    assert.equal(tools[0].output!.includes('factoryNotFound'), false, 'classification reads the complete receipt before the 200-character preview')
    assert.equal(tools[0].input!.includes('ALEX-45'), false, 'the target comes from the full input')
    t.diagnostic(JSON.stringify({ event: 'chat_tool_metadata', realTool: 'get_factory_task', errorCode: tools[0].errorCode, cases: cases.length, failed: tools.filter(tool => tool.state === 'error').length }))
  })
})
