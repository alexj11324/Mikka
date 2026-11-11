import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { EventEmitter } from 'node:events'

let transaction = false
let locked = false
let rollbackFails = false
/** The task's latest run, as latestTaskRun reads it; null when the task has no thread. */
let latest: Record<string, unknown> | null = null
const messages: { runId: string; text: string }[] = []
const stops: string[] = []
const executed: string[] = []
const releases: boolean[] = []
const client = {
  async query(sql: string) {
    if (sql === 'BEGIN') transaction = true
    else if (sql.startsWith('SELECT pg_advisory_xact_lock')) {
      assert.ok(transaction, 'the transaction pins the pooled backend while work runs')
      locked = true
    } else if (sql === 'COMMIT' || sql === 'ROLLBACK') {
      if (sql === 'ROLLBACK' && rollbackFails) throw new Error('connection lost')
      transaction = false
      locked = false
    } else throw new Error(`Unsupported by transaction pooling: ${sql}`)
    return { rows: [] }
  },
  release(discard: boolean) { releases.push(discard) },
}
let dispatchToTask: typeof import('./thread-dispatch').dispatchToTask
before(async () => {
  const applicationPool = { options: {}, end: async () => undefined }
  mock.module(new URL('./db/request-scope.ts', import.meta.url).href, { namedExports: { currentDatabasePool: () => applicationPool } })
  mock.module('pg', { namedExports: { Pool: class extends EventEmitter {
    connect() { return Promise.resolve(client) }
    end() { return Promise.resolve() }
  } } })
  mock.module(new URL('./agent-run-statuses.ts', import.meta.url).href, { namedExports: { UNFINISHED_RUN_STATUSES: ['queued', 'running'] } })
  mock.module(new URL('./db/index.ts', import.meta.url).href, { namedExports: { db: { execute: async (statement: { queryChunks?: unknown[] }) => { executed.push(JSON.stringify(statement.queryChunks ?? statement).includes('threadReplacedBy') ? 'replaced' : 'continues'); return { rows: [], rowCount: 1 } } }, pool: { connect: async () => client, query: async () => ({ rows: latest ? [latest] : [] }) } } })
  mock.module(new URL('./run-chain.ts', import.meta.url).href, { namedExports: { readRunChain: async () => null } })
  mock.module(new URL('./run-control.ts', import.meta.url).href, { namedExports: { sendOwnedRunMessage: async (_db: unknown, _user: string, message: { runId: string; text: string }) => { messages.push(message) } } })
  mock.module(new URL('./agent-runs.ts', import.meta.url).href, { namedExports: { requestRunStop: async (_user: string, runId: string) => { stops.push(runId) } } })
  ;({ dispatchToTask } = await import('./thread-dispatch'))
})
beforeEach(() => { transaction = false; locked = false; rollbackFails = false; releases.length = 0; latest = null; messages.length = 0; stops.length = 0; executed.length = 0 })

test('an unavailable machine releases the task lock so the same task can be retried', async () => {
  assert.deepEqual(await dispatchToTask('owner', 'task', { start: async () => {
    assert.ok(transaction && locked)
    return { error: 'machineUnavailable' }
  } }), { error: 'machineUnavailable' })
  assert.equal(locked, false)
  assert.deepEqual(await dispatchToTask('owner', 'task', { start: async () => {
    assert.ok(transaction && locked)
    return { runId: 'run' }
  } }), { runId: 'run', thread: 'new', threadId: 'run' })
  assert.equal(locked, false)
  assert.deepEqual(releases, [false, false])
})

test('a dispatch exception rolls back its lock and preserves the original failure', async () => {
  const failure = new Error('provider refused')
  await assert.rejects(dispatchToTask('owner', 'task', { start: async () => { throw failure } }), error => error === failure)
  assert.equal(locked, false)
  assert.deepEqual(releases, [false])
})

test('a failed rollback discards the connection without hiding the dispatch error', async () => {
  rollbackFails = true
  const failure = new Error('provider refused')
  await assert.rejects(dispatchToTask('owner', 'task', { start: async () => { throw failure } }), error => error === failure)
  assert.deepEqual(releases, [true])
})

// One task, one thread (decision 2026-11-01-1330, Alex 2026-11-02): later work on a task goes to its thread.
const run = (status: string) => ({ id: 'thread-1', status, stopRequestedAt: null, agentId: 'agent', deviceRepoId: null, botId: null, stopReason: null, error: null, summary: 'Added the README', lastReply: null, remoteUrl: 'https://github.com/alexj11324/Mikka_test', harness: 'claude_code', readOnly: false, cloudWorkspaceId: null, cloudBotId: null })
const starts: unknown[] = []
const start = async (previous: unknown) => { starts.push(previous); return { runId: 'run-2' } }

test('a follow-up on a working thread goes to it as a message; no new thread starts', async () => {
  latest = run('running'); starts.length = 0
  const result = await dispatchToTask('owner', 'task', { note: '再加一节安装说明', start })
  assert.deepEqual(result, { thread: 'message', runId: 'thread-1', threadId: 'thread-1', status: 'messageSent' })
  assert.deepEqual(messages, [{ runId: 'thread-1', text: '再加一节安装说明' }])
  assert.deepEqual(starts, [], 'nothing queued')
})

test('a follow-up on an ended thread runs the same thread again', async () => {
  latest = run('done'); starts.length = 0
  const result = await dispatchToTask('owner', 'task', { note: '再加一节安装说明', start })
  assert.ok('thread' in result)
  assert.equal(result.thread, 'continued')
  assert.deepEqual([(result as { continuesRunId: string }).continuesRunId, (result as { threadId: string }).threadId], ['thread-1', 'thread-1'])
  assert.equal((starts[0] as { id: string }).id, 'thread-1', 'started as the next run of that thread')
  assert.deepEqual(executed, ['continues'])
})

test('asking for a new thread is honoured only when the person said so; otherwise the thread is kept', async () => {
  latest = run('running'); starts.length = 0
  const kept = await dispatchToTask('owner', 'task', { note: '再加一节安装说明', newThread: true, explicit: async () => false, start })
  assert.ok('thread' in kept)
  assert.equal(kept.thread, 'message', 'the model asked, the person did not')
  assert.deepEqual(stops, [])
  const fresh = await dispatchToTask('owner', 'task', { note: '另开一个线程重新做', newThread: true, explicit: async () => true, start })
  assert.deepEqual(fresh, { runId: 'run-2', thread: 'new', threadId: 'run-2', replacedThreadId: 'thread-1' })
  assert.deepEqual(stops, ['thread-1'], 'the old thread stops: one thread works on a task at a time')
  assert.deepEqual(executed, ['replaced'])
})

test('an explicit replacement finishes the old stop even when an epoch already set the stop flag', async () => {
  latest = { ...run('queued'), stopRequestedAt: new Date() }; starts.length = 0
  const result = await dispatchToTask('owner', 'task', { newThread: true, explicit: async () => true, start })
  assert.deepEqual(result, { runId: 'run-2', thread: 'new', threadId: 'run-2', replacedThreadId: 'thread-1' })
  assert.deepEqual(stops, ['thread-1'])
})
