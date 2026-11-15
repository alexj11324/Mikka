import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'
import { isE2eTarget } from '../tests/helpers/e2e-target.mjs'
import { nextAuditRetentionDue } from './audit-retention-due'

// #1371: audit retention and outbox delivery no longer get an hourly sweep. The
// audit-retention due timer sleeps until nextAuditRetentionDue; each case writes one kind
// of work and checks it is due when the sweep would delete or deliver it.
const target = process.env.E2E_DATABASE_URL
const valid = isE2eTarget(target) && target === process.env.MIKKA_DATABASE_URL && target === process.env.DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !valid) throw new Error('Audit retention due tests require matching isolated loopback _e2e URLs')

const TABLES = ['workspace_audit_retention', 'workspace_audit_events', 'workspace_deletions', 'workspace_audit_outbox']
const HOUR = 3_600_000, DAY = 24 * HOUR
const nextHour = (ms: number) => Math.floor(ms / HOUR) * HOUR + HOUR

test('audit retention due times match what the sweep deletes or delivers', { skip: !valid }, async t => {
  const schema = `audit_due_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: target, max: 1 })
  await admin.query(`CREATE SCHEMA ${schema}`)
  for (const table of TABLES) await admin.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING DEFAULTS)`)
  const pool = new Pool({ connectionString: target, options: `-c search_path=${schema},public -c timezone=America/New_York`, max: 2 })
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end() })
  // In this test both databases are the same isolated one; production may split them.
  const due = () => nextAuditRetentionDue(pool, pool)
  const clear = async () => { for (const table of TABLES) await pool.query(`DELETE FROM ${schema}.${table}`) }
  const event = (workspaceId: string, createdAt: Date) => pool.query(`INSERT INTO ${schema}.workspace_audit_events (id,"workspaceId","actorType","actorName",action,category,"createdAt") VALUES ($1,$2,'system','System','audit.test','audit',$3)`, [randomUUID(), workspaceId, createdAt])
  const policy = (workspaceId: string, days: number | null, legalHold = false) => pool.query(`INSERT INTO ${schema}.workspace_audit_retention ("workspaceId","retentionDays","legalHold","configuredBy") VALUES ($1,$2,$3,'admin')`, [workspaceId, days, legalHold])

  await t.test('idle: nothing is due, so no timer runs', async () => {
    assert.equal(await due(), null)
  })

  await t.test('an empty deleted workspace with a finite policy wakes at the grace deadline', async () => {
    const ws = randomUUID(), deletedAt = new Date(Date.now() - 91 * DAY)
    await policy(ws, 365)
    await pool.query(`INSERT INTO ${schema}.workspace_deletions (id,"deletedAt") VALUES ($1,$2)`, [ws, deletedAt])
    assert.equal(await due(), deletedAt.getTime() + 90 * DAY)
    await pool.query(`UPDATE ${schema}.workspace_audit_retention SET "legalHold"=true WHERE "workspaceId"=$1`, [ws])
    assert.equal(await due(), null)
    await clear()
  })

  await t.test('events under a retention period are due in the hour after the oldest passes it', async () => {
    const ws = randomUUID(), oldest = new Date('2026-10-15T13:10:04.000Z')
    await policy(ws, 30)
    assert.equal(await due(), null, 'a period with no events has nothing to expire')
    await event(ws, oldest)
    await event(ws, new Date(oldest.getTime() + DAY))
    assert.equal(await due(), nextHour(oldest.getTime() + 30 * DAY))
    await pool.query(`UPDATE ${schema}.workspace_audit_retention SET "legalHold"=true`)
    assert.equal(await due(), null, 'a legal hold keeps everything')
    await clear()
  })

  await t.test('a deleted workspace is due when its 90-day grace ends, or later under a longer period', async () => {
    const ws = randomUUID(), deletedAt = new Date('2026-10-15T13:10:04.000Z')
    await pool.query(`INSERT INTO ${schema}.workspace_deletions (id,"deletedAt") VALUES ($1,$2)`, [ws, deletedAt])
    assert.equal(await due(), deletedAt.getTime() + 90 * DAY)
    const oldest = new Date(deletedAt.getTime() - 10 * DAY)
    await event(ws, oldest)
    await policy(ws, 365)
    assert.equal(await due(), nextHour(oldest.getTime() + 365 * DAY), 'the longer period wins')
    await clear()
  })

  await t.test('an undelivered audit receipt is due at once', async () => {
    const created = new Date(Date.now() - 1_000)
    await pool.query(`INSERT INTO ${schema}.workspace_audit_outbox (id,"workspaceId","createdAt") VALUES ($1,$2,$3)`, [randomUUID(), randomUUID(), created])
    assert.equal(await due(), created.getTime())
    await pool.query(`UPDATE ${schema}.workspace_audit_outbox SET "deliveredAt"=now()`)
    assert.equal(await due(), null)
    await clear()
  })
})
