import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { disposableDatabase } from '../tests/helpers/e2e-target.mjs'

// A connected account the provider refused, against real Postgres with the
// tracked migrations: it is marked for its own person only, read back as
// needing reconnection, and cleared or forgotten with it. Runs when one loopback
// *_e2e database is in all three URLs. REQUIRE_DB=1 makes a missing database fail.
const target = process.env.E2E_DATABASE_URL
const databaseUrl = disposableDatabase() && process.env.MIKKA_DATABASE_URL === target && process.env.DATABASE_URL === target ? target : undefined
if (!databaseUrl && process.env.REQUIRE_DB === '1') throw new Error('REQUIRE_DB=1 requires the matching loopback *_e2e database')
const dbTest = databaseUrl ? test : test.skip

dbTest('a refused account needs reconnecting for its own person only, until it works again or is forgotten', async t => {
  const [{ pool }, store] = await Promise.all([import('./db'), import('./composio-account-store')])
  const alice = `test-reconnect-alice-${randomUUID()}`, bob = `test-reconnect-bob-${randomUUID()}`
  const account = `ca_${randomUUID()}`
  for (const id of [alice, bob]) await pool.query(`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ($1, $1, $2, true, now(), now())`, [id, `${id}@example.com`])
  t.after(async () => {
    await pool.query('delete from composio_accounts where "userId" = any($1)', [[alice, bob]])
    await pool.query('delete from "user" where id = any($1)', [[alice, bob]])
    await pool.end()
  })
  const needs = async (userId: string) => (await store.listComposioAccountRecords(userId)).filter(record => record.accountId === account).map(record => record.needsReconnect)

  await store.saveComposioAccountEmail(alice, 'notion', account, 'alice@example.com')
  assert.deepEqual(await needs(alice), [false])
  await store.markComposioNeedsReconnect(alice, 'notion', account)
  assert.deepEqual(await needs(alice), [true])
  assert.equal((await store.listComposioAccountRecords(alice)).find(record => record.accountId === account)?.email, 'alice@example.com', 'the stored email stays')

  // Someone else's mark or clear never reaches Alice's account.
  await store.clearComposioNeedsReconnect(bob, account)
  assert.deepEqual(await needs(alice), [true])
  await store.markComposioNeedsReconnect(bob, 'notion', account)
  assert.deepEqual(await needs(bob), [])

  await store.clearComposioNeedsReconnect(alice, account)
  assert.deepEqual(await needs(alice), [false])

  // A reconnect retires (forgets) the old account, mark and all.
  await store.markComposioNeedsReconnect(alice, 'notion', account)
  await store.forgetComposioAccount(alice, account)
  assert.deepEqual(await needs(alice), [])
})
