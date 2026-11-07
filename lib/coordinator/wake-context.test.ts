import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { mock, test } from 'node:test'
import type { PoolClient } from 'pg'
import { databaseCommitScope, observeCommitEffects } from '../db/commit-effects'
import { createRequestDatabaseScope, inDatabaseTransaction, pool, withDatabaseClient } from '../db/request-scope'

test('deferred Coordinator consumers release the writer connection while retaining its database', { timeout: 5_000 }, async t => {
  const jobs: Array<() => Promise<unknown>> = []
  let scheduled: (() => void) | undefined
  const background = mock.module(new URL('../background.ts', import.meta.url).href, { namedExports: {
    afterJob: (_label: string, work: () => Promise<unknown>) => {
      // Next after() and the immediate fallback inherit the committing context.
      jobs.push(AsyncLocalStorage.bind(work))
      scheduled?.()
    },
  } })
  const wakes = await import('./wake-after-commit')
  const prior = wakes.coordinatorWakeTransport.wake
  const scope = createRequestDatabaseScope('postgres://fixture:fixture@127.0.0.1:1/wake_context_e2e')
  let released = false
  const statements: string[] = []
  const writer = { query: async (sql: string) => {
    assert.equal(released, false, 'a released writer must never receive a background query')
    statements.push(sql)
    return { command: sql, rows: [] }
  } } as unknown as PoolClient
  observeCommitEffects(writer)
  let expectedDatabase: object
  const observed: { ownerId: string; transaction: boolean; database: object }[] = []
  wakes.coordinatorWakeTransport.wake = async ownerId => {
    observed.push({ ownerId, transaction: inDatabaseTransaction(), database: databaseCommitScope(pool) })
  }
  const nextJob = () => jobs.length ? Promise.resolve() : new Promise<void>(resolve => { scheduled = resolve })
  t.after(async () => {
    background.restore()
    if (prior === undefined) delete wakes.coordinatorWakeTransport.wake
    else wakes.coordinatorWakeTransport.wake = prior
    await scope.close()
  })

  await scope.run(async () => {
    expectedDatabase = databaseCommitScope(pool)
    await withDatabaseClient(writer, async () => {
      await writer.query('BEGIN')
      wakes.wakeCoordinatorAfterCommit(writer, 'owner')
      assert.equal(jobs.length, 0)
      await writer.query('COMMIT')
      await nextJob()
    })
  })
  released = true
  await jobs.shift()!()
  assert.deepEqual(observed, [{ ownerId: 'owner', transaction: false, database: expectedDatabase! }])

  // The already-committed entry point can be called from the same ambient
  // scope and must leave its returned transaction before starting the consumer.
  released = false
  await scope.run(() => withDatabaseClient(writer, async () => {
    wakes.wakeCoordinatorSoon('owner')
    await nextJob()
  }))
  released = true
  await jobs.shift()!()
  assert.deepEqual(observed, [
    { ownerId: 'owner', transaction: false, database: expectedDatabase! },
    { ownerId: 'owner', transaction: false, database: expectedDatabase! },
  ])
  assert.deepEqual(statements, ['BEGIN', 'COMMIT'], 'the context boundary adds no SQL or new connection')
})
