import assert from 'node:assert/strict'
import { setTimeout } from 'node:timers/promises'
import { test } from 'node:test'
import { createRequestDatabaseScope, withDatabaseTransaction, db, pool } from './request-scope'

function connectionString(value: unknown) {
  return (value as { options: { connectionString: string } }).options.connectionString
}

test('overlapping request scopes keep Drizzle and Pool bound to their own clients', async () => {
  const firstUrl = 'postgres://first.example.test/worker-test'
  const secondUrl = 'postgres://second.example.test/worker-test'
  const first = createRequestDatabaseScope(firstUrl)
  const second = createRequestDatabaseScope(secondUrl)

  try {
    await Promise.all([
      first.run(async () => {
        await setTimeout(0)
        assert.equal(connectionString(pool), firstUrl)
        assert.equal(connectionString(db.$client), firstUrl)
        await setTimeout(0)
        assert.equal(connectionString(pool), firstUrl)
      }),
      second.run(async () => {
        await setTimeout(0)
        assert.equal(connectionString(pool), secondUrl)
        assert.equal(connectionString(db.$client), secondUrl)
        await setTimeout(0)
        assert.equal(connectionString(pool), secondUrl)
      }),
    ])
  } finally {
    await Promise.all([first.close(), second.close()])
  }
})

test('an ambient action transaction is isolated across async calls and restores the request database', async () => {
  type Transaction = Parameters<typeof withDatabaseTransaction>[0]
  const first = { select: () => 'first' } as unknown as Transaction
  const second = { select: () => 'second' } as unknown as Transaction
  const request = createRequestDatabaseScope('postgres://transaction.example.test/unit-test')
  try {
    await request.run(async () => {
      await Promise.all([
        withDatabaseTransaction(first, async () => { await setTimeout(0); assert.equal(db.select(), 'first') }),
        withDatabaseTransaction(second, async () => { await setTimeout(0); assert.equal(db.select(), 'second') }),
      ])
      assert.equal(connectionString(db.$client), 'postgres://transaction.example.test/unit-test')
    })
  } finally { await request.close() }
})
