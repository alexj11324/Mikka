import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
import { bots, coordinatorEvents, devices } from './db/schema'
import type { TaskDestination } from './task-destination'
import { personalSubmissionInput, recordPersonalSubmission, SubmissionConflictError } from './coordinator-submission'

const submissionId = 'a4000000-0000-4000-8000-000000000001'
const dialect = new PgDialect()
type Stored = { id: string; userId: string; botId: string | null; kind: string; dedupeKey: string; issueId: null; runId: null; payload: { text: string; taskDestination?: TaskDestination } }
function fixture() {
  const rows = new Map<string, Stored>()
  const botRows = new Map<string, { id: string; name: string; ownerId: string }>()
  const deviceRows = new Map<string, { id: string; ownerId: string; kind: string; enabled: boolean }>()
  const trace: string[] = []
  const state: { insertError?: Error; selectError?: Error; arbitrate?: (event: Stored) => Promise<void>; missingRead?: boolean } = {}
  const executor = {
    insert(table: unknown) {
      assert.equal(table, coordinatorEvents)
      return { values(event: Stored) { return { onConflictDoNothing(options: { target: unknown }) {
        assert.equal(options.target, coordinatorEvents.dedupeKey)
        return { async returning() {
          trace.push('insert')
          if (state.insertError) throw state.insertError
          await state.arbitrate?.(event)
          if (rows.has(event.dedupeKey)) return []
          rows.set(event.dedupeKey, structuredClone(event))
          return [{ id: event.id }]
        } }
      } } } }
    },
    select() { return { from(table: unknown) {
      assert.ok(table === coordinatorEvents || table === bots || table === devices)
      return { where(condition: SQL) {
        const query = dialect.sqlToQuery(condition)
        if (table === coordinatorEvents) assert.match(query.sql, /"coordinator_events"\."dedupeKey"/)
        else if (table === bots) { assert.match(query.sql, /"bots"\."id"/); assert.match(query.sql, /"bots"\."ownerId"/) }
        else { assert.match(query.sql, /"devices"\."id"/); assert.match(query.sql, /"devices"\."ownerId"/); assert.match(query.sql, /"devices"\."kind"/); assert.match(query.sql, /"devices"\."enabled"/) }
        return { async limit(count: number) {
          assert.equal(count, 1)
          if (table === coordinatorEvents) trace.push('read')
          if (state.selectError) throw state.selectError
          if (state.missingRead) return []
          const row = table === coordinatorEvents ? rows.get(query.params[0] as string)
            : table === bots ? [...botRows.values()].find(bot => query.params.includes(bot.id) && query.params.includes(bot.ownerId))
              : [...deviceRows.values()].find(device => query.params.includes(device.id) && query.params.includes(device.ownerId) && query.params.includes(device.kind) && query.params.includes(device.enabled))
          return row ? [structuredClone(row)] : []
        } }
      } }
    } } },
  } as unknown as Parameters<typeof recordPersonalSubmission>[0]
  return { rows, botRows, deviceRows, state, trace, executor }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

test('personal input normalizes text and UUID and rejects question/authority fields', () => {
  assert.deepEqual(personalSubmissionInput.parse({ text: '  hello  ', submissionId: submissionId.toUpperCase() }), { text: 'hello', submissionId })
  for (const extra of [{ questionId: submissionId }, { userId: 'foreign' }, { botId: submissionId }, { action: 'approve' }]) assert.equal(personalSubmissionInput.safeParse({ text: 'hello', submissionId, ...extra }).success, false)
  for (const body of [{ text: '' }, { text: 'x', submissionId: 'invalid' }, { text: 'x', submissionId: null }]) assert.equal(personalSubmissionInput.safeParse(body).success, false)
})

test('concurrent identical submissions use the existing unique target and one immutable event', async () => {
  const f = fixture()
  const results = await Promise.all(Array.from({ length: 10 }, () => recordPersonalSubmission(f.executor, 'owner', 'hello', { submissionId })))
  assert.equal(f.rows.size, 1)
  assert.equal(results.filter(result => !result.duplicate).length, 1)
  assert.equal(results.filter(result => result.duplicate).length, 9)
  assert.deepEqual(new Set(results.map(result => result.eventId)), new Set([...f.rows.values()].map(row => row.id)))
  const before = structuredClone([...f.rows.values()])
  await assert.rejects(recordPersonalSubmission(f.executor, 'owner', 'different', { submissionId }), SubmissionConflictError)
  assert.deepEqual([...f.rows.values()], before)
})

test('an uncommitted winner blocks retry completion and reading until commit', async () => {
  for (const changed of [false, true]) {
    const f = fixture(), entered = deferred<void>(), outcome = deferred<void>()
    f.state.arbitrate = async event => {
      entered.resolve()
      await outcome.promise
      f.rows.set(event.dedupeKey, { ...event, id: 'committed-winner', payload: { text: 'winner' } })
    }
    let settled = false
    const request = recordPersonalSubmission(f.executor, 'owner', changed ? 'different' : 'winner', { submissionId })
      .then(value => { settled = true; return { value, error: undefined } }, error => { settled = true; return { value: undefined, error } })
    await entered.promise
    assert.equal(settled, false); assert.deepEqual(f.trace, ['insert']); assert.equal(f.rows.size, 0)
    outcome.resolve()
    const result = await request
    if (changed) assert.ok(result.error instanceof SubmissionConflictError)
    else { assert.equal(result.error, undefined); assert.deepEqual(result.value, { duplicate: true, eventId: 'committed-winner' }) }
    assert.deepEqual(f.trace, ['insert', 'read'])
    assert.equal([...f.rows.values()][0].payload.text, 'winner')
  }
})

test('a rolled-back winner allows the waiting insertion without a duplicate read', async () => {
  const f = fixture(), entered = deferred<void>(), rollback = deferred<void>()
  f.state.arbitrate = async () => { entered.resolve(); await rollback.promise }
  let settled = false
  const request = recordPersonalSubmission(f.executor, 'owner', 'waiting message', { submissionId }).then(value => { settled = true; return value })
  await entered.promise
  assert.equal(settled, false); assert.deepEqual(f.trace, ['insert']); assert.equal(f.rows.size, 0)
  rollback.resolve()
  assert.deepEqual(await request, { duplicate: false, eventId: [...f.rows.values()][0].id })
  assert.deepEqual(f.trace, ['insert']); assert.equal(f.rows.size, 1)
})

test('an unresolved conflict read never becomes an accepted retry', async () => {
  const f = fixture()
  await recordPersonalSubmission(f.executor, 'owner', 'hello', { submissionId })
  f.state.missingRead = true
  await assert.rejects(recordPersonalSubmission(f.executor, 'owner', 'hello', { submissionId }), /personalSubmissionUnavailable/)
  assert.equal(f.rows.size, 1)
})

test('same submission UUID is isolated by authenticated owner and actual chat identity', async () => {
  const f = fixture(), botId = '24000000-0000-4000-8000-000000000002'
  for (const [owner, bot] of [['owner', null], ['foreign', null], ['owner', botId]] as const) {
    const result = await recordPersonalSubmission(f.executor, owner, 'hello', { submissionId, botId: bot })
    assert.equal(result.duplicate, false)
    assert.ok(result.eventId)
  }
  assert.equal(f.rows.size, 3)
  assert.equal(new Set(f.rows.keys()).size, 3)
  assert.ok([...f.rows.keys()].every(key => /^personal_submission:v1:[0-9a-f]{64}$/.test(key)))
})

test('quoted body changes conflict and legacy submissions remain independent', async () => {
  const f = fixture()
  await recordPersonalSubmission(f.executor, 'owner', '<quote version="1">a</quote>\nhello', { submissionId })
  await assert.rejects(recordPersonalSubmission(f.executor, 'owner', '<quote version="2">a</quote>\nhello', { submissionId }), SubmissionConflictError)
  await recordPersonalSubmission(f.executor, 'owner', 'legacy')
  await recordPersonalSubmission(f.executor, 'owner', 'legacy')
  assert.equal(f.rows.size, 3)
})

test('unexpected stored scope and database failures are never accepted as a duplicate', async () => {
  const f = fixture()
  await recordPersonalSubmission(f.executor, 'owner', 'hello', { submissionId })
  const key = [...f.rows.keys()][0]
  f.rows.get(key)!.userId = 'foreign'
  await assert.rejects(recordPersonalSubmission(f.executor, 'owner', 'hello', { submissionId }), SubmissionConflictError)
  const failed = fixture(), fault = new Error('synthetic SQL failure')
  failed.state.insertError = fault
  await assert.rejects(recordPersonalSubmission(failed.executor, 'owner', 'hello', { submissionId }), error => error === fault)
  assert.equal(failed.rows.size, 0)
  f.rows.get(key)!.userId = 'owner'; f.state.selectError = fault
  await assert.rejects(recordPersonalSubmission(f.executor, 'owner', 'hello', { submissionId }), error => error === fault)
})

// Invoke the real route/action with in-memory adapters; no server, DB or wake runs.
let userId: string | null = 'owner'
let current = fixture()
const callbacks: Array<() => unknown> = []
let POST: (request: Request) => Promise<Response>
let sendCoordinatorMessage: typeof import('../app/actions/coordinator').sendCoordinatorMessage
before(async () => {
  mock.module('@/lib/auth', { namedExports: { auth: { api: { getSession: async () => userId ? { user: { id: userId } } : null } } } })
  mock.module('@/lib/db', { namedExports: { db: new Proxy({}, { get(_target, key) { return Reflect.get(current.executor, key) } }) } })
  mock.module('@/lib/request-log', { namedExports: { noteLogUser: () => undefined, withRequestLog: (_path: string, handler: unknown) => handler } })
  mock.module('@/lib/coordinator/store', { namedExports: { chatView: async () => ({}), botChats: async () => ({}) } })
  mock.module('@/lib/coordinator/wake', { namedExports: { coordinatorEnabled: () => true, wakeCoordinator: () => { throw new Error('test must not execute wake') } } })
  mock.module('next/server', { namedExports: { NextResponse: { json: (body: unknown, options?: ResponseInit) => Response.json(body, options) }, after: (callback: () => unknown) => callbacks.push(callback) } })
  mock.module('next/headers', { namedExports: { headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) } })
  ;({ POST } = await import('../app/api/coordinator/messages/route'))
  ;({ sendCoordinatorMessage } = await import('../app/actions/coordinator'))
})
const request = (body: unknown) => new Request('https://synthetic.example/api/coordinator/messages', { method: 'POST', body: JSON.stringify(body) })

test('HTTP handler and action share personal submission identity and expose payload conflicts', async () => {
  current = fixture(); callbacks.length = 0; userId = 'owner'
  const accepted = await POST(request({ text: ' hello ', submissionId }))
  assert.equal(accepted.status, 202)
  assert.deepEqual(await sendCoordinatorMessage('hello', null, null, submissionId), { queued: true })
  assert.equal(current.rows.size, 1)
  assert.equal((await POST(request({ text: 'changed', submissionId }))).status, 409)
  assert.deepEqual(await sendCoordinatorMessage('changed', null, null, submissionId), { error: 'submissionConflict', params: undefined })
  assert.equal(callbacks.length, 2, 'existing wake scheduling retained for accepted attempts, never conflict')
  userId = 'foreign'
  assert.equal((await POST(request({ text: 'hello', submissionId }))).status, 202)
  assert.equal(current.rows.size, 2)
})

test('HTTP handler rejects anonymous and unsupported question submissions without writing or waking', async () => {
  current = fixture(); callbacks.length = 0; userId = null
  assert.equal((await POST(request({ text: 'hello', submissionId }))).status, 401)
  userId = 'owner'
  assert.equal((await POST(request({ text: 'hello', submissionId, questionId: submissionId }))).status, 400)
  assert.equal(current.rows.size, 0); assert.equal(callbacks.length, 0)
})

test('HTTP and action propagate unknown SQL errors without an accepted response or wake', async () => {
  current = fixture(); callbacks.length = 0; userId = 'owner'
  const failure = new Error('synthetic unknown database failure')
  current.state.insertError = failure
  await assert.rejects(POST(request({ text: 'hello', submissionId })), error => error === failure)
  await assert.rejects(sendCoordinatorMessage('hello', null, null, submissionId), error => error === failure)
  assert.equal(current.rows.size, 0); assert.equal(callbacks.length, 0)
})

test('legacy HTTP and action calls without IDs remain valid separate submissions', async () => {
  current = fixture(); callbacks.length = 0; userId = 'owner'
  assert.equal((await POST(request({ text: 'historical client' }))).status, 202)
  assert.deepEqual(await sendCoordinatorMessage('historical client'), { queued: true })
  assert.equal(current.rows.size, 2); assert.equal(callbacks.length, 2)
  assert.ok([...current.rows.keys()].every(key => key.startsWith('user_message:')))
})

test('action checks actual Bot ownership before new submissions and duplicate retries', async () => {
  current = fixture(); callbacks.length = 0; userId = 'owner'
  const botId = 'b4000000-0000-4000-8000-000000000002'
  current.botRows.set(botId, { id: botId, name: 'Synthetic Bot', ownerId: 'foreign' })
  assert.deepEqual(await sendCoordinatorMessage('hello', null, botId, submissionId), { error: 'validationGeneric', params: undefined })
  assert.equal(current.rows.size, 0); assert.equal(callbacks.length, 0)
  current.botRows.get(botId)!.ownerId = 'owner'
  assert.deepEqual(await sendCoordinatorMessage('hello', null, botId, submissionId), { queued: true })
  assert.equal([...current.rows.values()][0].botId, botId)
  assert.equal((await POST(request({ text: 'hello', submissionId }))).status, 202)
  assert.equal(current.rows.size, 2, 'Bot and Coordinator are separate chats')
  current.botRows.get(botId)!.ownerId = 'foreign'
  assert.deepEqual(await sendCoordinatorMessage('hello', null, botId, submissionId), { error: 'validationGeneric', params: undefined })
  assert.equal(current.rows.size, 2); assert.equal(callbacks.length, 2)
})

test('actual action freezes serialized quotes across retries and rejects quote changes', async () => {
  current = fixture(); callbacks.length = 0; userId = 'owner'
  const quote = { artifactId: 'b4000000-0000-4000-8000-000000000003', version: 1, kind: 'text' as const, text: 'Quoted selection', label: 'Synthetic artifact' }
  assert.deepEqual(await sendCoordinatorMessage('hello', quote, null, submissionId), { queued: true })
  const original = structuredClone([...current.rows.values()])
  assert.match(original[0].payload.text, /Quoted selection/)
  assert.notEqual(original[0].payload.text, 'hello')
  assert.deepEqual(await sendCoordinatorMessage('hello', { ...quote }, null, submissionId), { queued: true })
  assert.deepEqual(await sendCoordinatorMessage('hello', { ...quote, version: 2 }, null, submissionId), { error: 'submissionConflict', params: undefined })
  assert.deepEqual([...current.rows.values()], original)
  assert.equal(callbacks.length, 2)
})

test('new-task machine choice is owner-checked, preserved separately from copy and frozen across retries', async () => {
  process.env.MIKKA_ISSUE_TOOLS_ENABLED = '1'
  current = fixture(); callbacks.length = 0; userId = 'owner'
  const deviceId = 'b4000000-0000-4000-8000-000000000004'
  const destination = { kind: 'device' as const, deviceId }
  current.deviceRows.set(deviceId, { id: deviceId, ownerId: 'foreign', kind: 'local', enabled: true })
  assert.deepEqual(await sendCoordinatorMessage('do the task', null, null, submissionId, destination), { error: 'deviceNotFound', params: undefined })
  assert.equal(current.rows.size, 0)
  current.deviceRows.get(deviceId)!.ownerId = 'owner'
  current.deviceRows.get(deviceId)!.enabled = false
  assert.deepEqual(await sendCoordinatorMessage('do the task', null, null, submissionId, destination), { error: 'deviceNotFound', params: undefined })
  current.deviceRows.get(deviceId)!.enabled = true
  assert.deepEqual(await sendCoordinatorMessage('do the task', null, null, undefined, destination), { error: 'validationGeneric', params: undefined })
  assert.deepEqual(await sendCoordinatorMessage('do the task', null, null, submissionId, destination), { queued: true })
  assert.equal([...current.rows.values()][0].payload.text, 'do the task')
  assert.deepEqual([...current.rows.values()][0].payload.taskDestination, destination)
  ;[...current.rows.values()][0].issueId = 'c4000000-0000-4000-8000-000000000004' as never
  assert.deepEqual(await sendCoordinatorMessage('do the task', null, null, submissionId, destination), { queued: true })
  assert.deepEqual(await sendCoordinatorMessage('do the task', null, null, submissionId, { kind: 'cloud' }), { error: 'submissionConflict', params: undefined })
  current.deviceRows.get(deviceId)!.ownerId = 'foreign'
  assert.deepEqual(await sendCoordinatorMessage('do the task', null, null, submissionId, destination), { error: 'deviceNotFound', params: undefined })
  assert.equal(current.rows.size, 1)
  delete process.env.MIKKA_ISSUE_TOOLS_ENABLED
})

test('new-task submission fails closed when issue tools are disabled', async () => {
  current = fixture(); callbacks.length = 0; userId = 'owner'
  delete process.env.MIKKA_ISSUE_TOOLS_ENABLED
  assert.deepEqual(await sendCoordinatorMessage('do the task', null, null, submissionId, { kind: 'cloud' }), { error: 'issueToolsDisabled', params: undefined })
  assert.equal(current.rows.size, 0)
  assert.equal(callbacks.length, 0)
})
