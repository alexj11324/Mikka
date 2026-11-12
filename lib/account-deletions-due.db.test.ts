import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { isE2eTarget } from '../tests/helpers/e2e-target.mjs'
import { nextAccountDeletionsDue } from './account-deletions-due'

// #1371: account deletion and chat-file cleanup no longer get an hourly sweep. The
// account-deletions due timer sleeps until nextAccountDeletionsDue; each case writes one
// kind of work and checks it is due exactly when its sweep would select it.
const target = process.env.E2E_DATABASE_URL
const valid = isE2eTarget(target) && target === process.env.MIKKA_DATABASE_URL && target === process.env.DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !valid) throw new Error('Account deletion due tests require matching isolated loopback _e2e URLs')

const TABLES = ['account_deletion_guards', 'account_deletion_jobs', 'chat_attachments', 'chat_attachment_retirements']

test('account-deletion due times match what the sweeps select', { skip: !valid }, async t => {
  const schema = `account_deletions_due_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: target, max: 1 })
  await admin.query(`CREATE SCHEMA ${schema}`)
  for (const table of TABLES) await admin.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING DEFAULTS INCLUDING CONSTRAINTS)`)
  const pool = new Pool({ connectionString: target, options: `-c search_path=${schema}`, max: 2 })
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end() })
  const due = () => nextAccountDeletionsDue(pool)
  const clear = async () => { for (const table of TABLES) await pool.query(`DELETE FROM ${table}`) }
  const job = (values: { stage: string; blocked?: string[]; updatedAt: Date; storageNotBefore?: Date }) =>
    pool.query(`INSERT INTO account_deletion_jobs (id,"subjectUserId","subjectEmailHash",stage,"blockedReasons","updatedAt","storageNotBefore") VALUES ($1,'subject',$2,$3,$4,$5,$6)`,
      [randomUUID(), 'a'.repeat(64), values.stage, JSON.stringify(values.blocked ?? []), values.updatedAt, values.storageNotBefore ?? null])
  const file = (values: { createdAt: Date; usedAt?: Date; removedAt?: Date; uploadKey?: string; uploadExpiresAt?: Date }) =>
    pool.query(`INSERT INTO chat_attachments (id,"userId","botId",name,"mediaType",size,"createdAt","usedAt","removedAt","uploadKey","uploadExpiresAt") VALUES ($1,'owner',$7,'f','text/plain',1,$2,$3,$4,$5,$6)`,
      [randomUUID(), values.createdAt, values.usedAt ?? null, values.removedAt ?? null, values.uploadKey ?? null, values.uploadExpiresAt ?? null, randomUUID()])

  await t.test('idle: nothing is due, so no timer runs', async () => {
    assert.equal(await due(), null)
  })

  await t.test('a requested deletion is due at once; a failed step or a sole admin an hour after the last try', async () => {
    const at = new Date(Date.now() - 5_000)
    await job({ stage: 'requested', updatedAt: at })
    assert.equal(await due(), at.getTime())
    await clear()
    await job({ stage: 'requested', blocked: ['deletion_step_failed'], updatedAt: at })
    assert.equal(await due(), at.getTime() + 3_600_000)
    await job({ stage: 'completed', updatedAt: new Date(0) })
    assert.equal(await due(), at.getTime() + 3_600_000, 'completed jobs are never due')
    await clear()
  })

  await t.test('storage waiting for upload grants is due when they expire', async () => {
    const notBefore = new Date(Date.now() + 20 * 60_000)
    await job({ stage: 'storage_pending', blocked: ['upload_grants_not_expired'], updatedAt: new Date(), storageNotBefore: notBefore })
    assert.equal(await due(), notBefore.getTime())
    await clear()
  })

  await t.test('an unused upload is due a day later; a removed one once its grant expires; a used one never', async () => {
    const created = new Date(Date.now() - 60_000)
    await file({ createdAt: created, usedAt: new Date() })
    assert.equal(await due(), null)
    await file({ createdAt: created })
    assert.equal(await due(), created.getTime() + 86_400_000 + 1)
    const expires = new Date(Date.now() + 10 * 60_000)
    await file({ createdAt: created, removedAt: new Date(), uploadKey: 'upload', uploadExpiresAt: expires })
    assert.equal(await due(), expires.getTime() + 1)
    await clear()
  })

  await t.test('a pending erasure owns its deadlines while a completed receipt cannot hide remaining cleanup', async () => {
    const past = new Date(Date.now() - 30_000), release = new Date(Date.now() + 90_000)
    await job({ stage: 'storage_pending', blocked: ['upload_grants_not_expired'], updatedAt: past, storageNotBefore: release })
    await pool.query(`UPDATE account_deletion_jobs SET "subjectUserId"='owner'`)
    await pool.query(`INSERT INTO account_deletion_guards("subjectId","jobId") SELECT "subjectUserId",id FROM account_deletion_jobs`)
    await file({ createdAt: past, removedAt: past })
    await pool.query(`INSERT INTO chat_attachment_retirements("storageKey","userId","notBefore") VALUES ('key','owner',$1)`, [past])
    assert.equal(await due(), release.getTime())
    await pool.query(`UPDATE account_deletion_jobs SET stage='completed'`)
    assert.equal(await due(), past.getTime())
    await clear()
  })

  await t.test('a retired object is due at its notBefore', async () => {
    const notBefore = new Date(Date.now() + 90_000)
    await pool.query(`INSERT INTO chat_attachment_retirements ("storageKey","userId","notBefore") VALUES ('key','owner',$1)`, [notBefore])
    assert.equal(await due(), notBefore.getTime())
    await clear()
  })
})
