import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { mock, test } from 'node:test'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { validateTarget } from '../scripts/run-db-tests.mjs'

const databaseURL = process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !databaseURL) throw new Error('Onboarding tests require an isolated database')

test('onboarding backfill, new accounts and session-owned idempotent completion', { skip: !databaseURL }, async (t) => {
  validateTarget({ E2E_DATABASE_URL: databaseURL, MIKKA_DATABASE_URL: databaseURL, DATABASE_URL: databaseURL })
  const schema = `onboarding_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: databaseURL })
  await admin.query(`CREATE SCHEMA "${schema}"`)
  const pool = new Pool({ connectionString: databaseURL, options: `-c search_path=${schema}` })
  try {
    await pool.query(`CREATE TABLE "user" (id text PRIMARY KEY); INSERT INTO "user" VALUES ('existing'), ('alice')`)
    const migration = await readFile(new URL('../drizzle/20261030213254_user_onboarding.sql', import.meta.url), 'utf8')
    await pool.query(migration)
    let sessionUser: string | null = 'bob'
    mock.module('@/lib/db', { namedExports: { db: drizzle(pool) } })
    mock.module('next/headers', { namedExports: { headers: async () => new Headers() } })
    // Only the existing session boundary is synthetic; storage and the action execute for real.
    mock.module('@/lib/auth', { namedExports: { auth: { api: { getSession: async () => sessionUser ? { user: { id: sessionUser } } : null } } } })
    const { onboardingDone } = await import('./onboarding')
    const { completeOnboarding, resetOnboarding } = await import('../app/actions/onboarding')

    await t.test('existing accounts are backfilled; new accounts remain incomplete on migration replay', async () => {
      assert.equal(await onboardingDone('existing'), true)
      assert.equal(await onboardingDone('alice'), true)
      const before = (await pool.query('SELECT * FROM user_onboarding ORDER BY "userId"')).rows
      await pool.query(`INSERT INTO "user" VALUES ('bob'), ('carol')`)
      assert.equal(await onboardingDone('bob'), false)
      await pool.query(migration)
      assert.deepEqual((await pool.query('SELECT * FROM user_onboarding ORDER BY "userId"')).rows, before)
      assert.equal(await onboardingDone('bob'), false)
    })

    await t.test('completion uses the signed-in person and repeated completion preserves the first timestamp', async () => {
      await Reflect.apply(completeOnboarding, undefined, ['carol'])
      assert.equal(await onboardingDone('bob'), true)
      assert.equal(await onboardingDone('carol'), false)
      const before = (await pool.query(`SELECT * FROM user_onboarding WHERE "userId"='bob'`)).rows
      await completeOnboarding()
      assert.deepEqual((await pool.query(`SELECT * FROM user_onboarding WHERE "userId"='bob'`)).rows, before)
    })


    await t.test('reset replays only the signed-in person’s guide and is idempotent', async () => {
      await Reflect.apply(resetOnboarding, undefined, ['alice'])
      assert.equal(await onboardingDone('bob'), false)
      assert.equal(await onboardingDone('alice'), true)
      await resetOnboarding()
      assert.equal(await onboardingDone('bob'), false)
      await completeOnboarding()
      assert.equal(await onboardingDone('bob'), true)
    })

    await t.test('an absent session cannot complete another account', async () => {
      sessionUser = null
      await assert.rejects(completeOnboarding(), { code: 'authRequired' })
      await assert.rejects(resetOnboarding(), { code: 'authRequired' })
      assert.equal(await onboardingDone('carol'), false)
    })
  } finally {
    console.log(`Retained onboarding test schema: ${schema}`)
    mock.restoreAll()
    await pool.end()
    await admin.end()
  }
})
