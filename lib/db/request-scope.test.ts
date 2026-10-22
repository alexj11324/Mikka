import assert from 'node:assert/strict'
import { setTimeout } from 'node:timers/promises'
import { test } from 'node:test'
import { createRequestDatabaseScope, db, pool } from './request-scope'

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
