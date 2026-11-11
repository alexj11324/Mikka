import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { dbUrl } from '../../tests/support/workspace-admin-db'

test('live work scheduled before the Workspace owner commits uses an independent transaction', { skip: !dbUrl }, async t => {
  const jobs: Promise<unknown>[] = []
  const background = mock.module(new URL('../background.ts', import.meta.url).href, {
    namedExports: { afterJob: (_label: string, work: () => unknown) => { jobs.push(Promise.resolve(work())) } },
  })
  t.after(() => background.restore())
  const { workspaceDb, workspacePool, workspaceTransactionKey } = await import('../workspace-db')
  const { pool } = await import('../db')
  const { scheduleLive } = await import('./notify')
  t.after(async () => { await Promise.all([pool.end(), workspacePool.end()]) })
  const started = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  let ownerKey: object | null = null, backgroundKey: object | null = null
  let completed = false
  try {
    await workspaceDb.transaction(async () => {
      ownerKey = workspaceTransactionKey()
      scheduleLive(async () => {
        await workspaceDb.transaction(async tx => {
          backgroundKey = workspaceTransactionKey()
          started.resolve()
          await finish.promise
          await tx.execute((await import('drizzle-orm')).sql`select 1`)
        })
        completed = true
      })
      await started.promise
    })
  } finally { finish.resolve(); await Promise.all(jobs) }
  assert.ok(ownerKey)
  assert.ok(backgroundKey)
  assert.notEqual(backgroundKey, ownerKey, 'a delayed live send must not borrow a still-active owner lease')
  assert.equal(completed, true, 'its transaction remains usable after the writer commits')
})
