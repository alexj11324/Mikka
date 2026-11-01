import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'

let transaction = false
let locked = false
let rollbackFails = false
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
  mock.module(new URL('./agent-run-statuses.ts', import.meta.url).href, { namedExports: { UNFINISHED_RUN_STATUSES: ['queued', 'running'] } })
  mock.module(new URL('./db/index.ts', import.meta.url).href, { namedExports: { db: {}, pool: { connect: async () => client, query: async () => ({ rows: [] }) } } })
  mock.module(new URL('./run-chain.ts', import.meta.url).href, { namedExports: { readRunChain: async () => null } })
  mock.module(new URL('./run-control.ts', import.meta.url).href, { namedExports: { sendOwnedRunMessage: async () => {} } })
  ;({ dispatchToTask } = await import('./thread-dispatch'))
})
beforeEach(() => { transaction = false; locked = false; rollbackFails = false; releases.length = 0 })

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
