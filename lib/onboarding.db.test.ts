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
    const progressMigration = await readFile(new URL('../drizzle/20261115214951_onboarding_progress_and_setup_checklist.sql', import.meta.url), 'utf8')
    await pool.query(progressMigration)
    let sessionUser: string | null = 'bob'
    mock.module('@/lib/db', { namedExports: { db: drizzle(pool) } })
    mock.module('@/lib/server-runtime/headers', { namedExports: { headers: async () => new Headers() } })
    // Only the existing session boundary is synthetic; storage and the action execute for real.
    mock.module('@/lib/auth', { namedExports: { auth: { api: { getSession: async () => sessionUser ? { user: { id: sessionUser }, session: { id: 'onboarding-fixture-session' } } : null } } } })
    const { onboardingDone, readOnboardingProgress, setupChecklistDismissed, dismissSetupChecklist, restoreSetupChecklist } = await import('./onboarding')
    const { completeOnboarding, resetOnboarding, saveOnboardingStep } = await import('../app/actions/onboarding')

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

    await t.test('the guide\'s place is saved for the signed-in person, resumes, and goes away when the guide ends', async () => {
      await resetOnboarding()
      assert.equal(await readOnboardingProgress('bob'), null)
      assert.deepEqual(await saveOnboardingStep({ step: 2, status: { 0: 'done', 1: 'skipped' } }), { step: 2, status: { 0: 'done', 1: 'skipped' } })
      assert.deepEqual(await readOnboardingProgress('bob'), { step: 2, status: { 0: 'done', 1: 'skipped' } })
      // The latest save wins, as from another device; an impossible place is reduced, not stored.
      await Reflect.apply(saveOnboardingStep, undefined, [{ step: 7, status: { 3: 'done', 9: 'done' } }])
      assert.deepEqual(await readOnboardingProgress('bob'), { step: 3, status: { 3: 'done' } })
      assert.equal(await readOnboardingProgress('carol'), null)
      await completeOnboarding()
      assert.equal(await onboardingDone('bob'), true)
      assert.equal(await readOnboardingProgress('bob'), null)
      await pool.query(progressMigration)
    })

    await t.test('the setup checklist is hidden per person and workspace, idempotently', async () => {
      const workspace = randomUUID()
      assert.equal(await setupChecklistDismissed('bob', workspace), false)
      await dismissSetupChecklist('bob', workspace)
      await dismissSetupChecklist('bob', workspace)
      assert.equal(await setupChecklistDismissed('bob', workspace), true)
      assert.equal(await setupChecklistDismissed('carol', workspace), false)
      assert.equal(await setupChecklistDismissed('bob', randomUUID()), false)
    })

    await t.test('restoring a checklist preserves another person, another workspace and the completed guide', async () => {
      const workspace = randomUUID(), otherWorkspace = randomUUID()
      for (const [user, id] of [['bob', workspace], ['carol', workspace], ['bob', otherWorkspace]]) await dismissSetupChecklist(user, id)
      await completeOnboarding()
      await restoreSetupChecklist('bob', workspace)
      await restoreSetupChecklist('bob', workspace)
      assert.equal(await setupChecklistDismissed('bob', workspace), false)
      assert.equal(await setupChecklistDismissed('carol', workspace), true)
      assert.equal(await setupChecklistDismissed('bob', otherWorkspace), true)
      assert.equal(await onboardingDone('bob'), true)
    })

    await t.test('an absent session cannot complete another account', async () => {
      sessionUser = null
      await assert.rejects(completeOnboarding(), { code: 'authRequired' })
      await assert.rejects(resetOnboarding(), { code: 'authRequired' })
      await assert.rejects(saveOnboardingStep({ step: 1, status: {} }), { code: 'authRequired' })
      assert.equal(await onboardingDone('carol'), false)
    })
  } finally {
    console.log(`Retained onboarding test schema: ${schema}`)
    mock.restoreAll()
    await pool.end()
    await admin.end()
  }
})
