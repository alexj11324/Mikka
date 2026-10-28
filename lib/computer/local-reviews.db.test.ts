import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { decideLocalComputerReview, pendingLocalComputerReviews } from './local-reviews'

const url = process.env.COMPUTER_TEST_DATABASE_URL ?? process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !url) throw new Error('Computer database test URL required')
test('local decisions bind owner, device, live run and exact digest, and cannot be replayed', { skip: !url }, async () => {
  const target = new URL(url!)
  assert.equal(process.env.CI, 'true')
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && ['/computer_test', '/mikka_e2e'].includes(target.pathname))
  const schema = `local_review_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  const [device, run, id] = [randomUUID(), randomUUID(), randomUUID()]
  const digest = createHash('sha256').update('fixture').digest('hex')
  try {
    await pool.query(`CREATE TABLE devices (id uuid PRIMARY KEY,"ownerId" text NOT NULL,name text NOT NULL,kind text NOT NULL,enabled boolean NOT NULL);
      CREATE TABLE agent_runs (id uuid PRIMARY KEY,"deviceId" uuid,"userId" text,status text,"stopRequestedAt" timestamptz,"leaseExpiresAt" timestamptz);
      CREATE TABLE computer_run_bindings ("runId" uuid PRIMARY KEY);
      CREATE TABLE local_computer_reviews (id uuid PRIMARY KEY,"deviceId" uuid,"runId" uuid,"userId" text,target text,display text,call jsonb,digest text,"expiresAt" timestamptz,"seenAt" timestamptz,decision boolean)`)
    await pool.query("INSERT INTO devices VALUES ($1,'owner','fixture','local',true)", [device])
    await pool.query("INSERT INTO agent_runs VALUES ($1,$2,'owner','running',NULL,now()+interval '1 minute')", [run, device])
    await pool.query(`INSERT INTO local_computer_reviews VALUES ($1,$2,$3,'owner','target',NULL,'{"name":"click"}',$4,now()+interval '1 minute',now(),NULL)`, [id, device, run, digest])
    assert.equal((await pendingLocalComputerReviews(pool, 'other')).length, 0)
    assert.equal((await pendingLocalComputerReviews(pool, 'owner')).length, 1)
    assert.equal(await decideLocalComputerReview(pool, 'other', id, digest, true), false)
    assert.equal(await decideLocalComputerReview(pool, 'owner', id, 'f'.repeat(64), true), false)
    for (const update of [
      "UPDATE agent_runs SET \"userId\"='other'",
      `UPDATE agent_runs SET "deviceId"='${randomUUID()}'`,
      'UPDATE agent_runs SET "stopRequestedAt"=now()',
      'UPDATE agent_runs SET "leaseExpiresAt"=now()-interval \'1 second\'',
      'UPDATE devices SET enabled=false',
      'UPDATE local_computer_reviews SET "seenAt"=now()-interval \'11 seconds\'',
      'UPDATE local_computer_reviews SET "expiresAt"=now()-interval \'1 second\'',
      'UPDATE devices SET kind=\'cloud\'',
      `INSERT INTO computer_run_bindings VALUES ('${run}')`,
    ]) {
      await pool.query(update)
      assert.equal(await decideLocalComputerReview(pool, 'owner', id, digest, true), false)
      await pool.query(`UPDATE agent_runs SET "stopRequestedAt"=NULL,"leaseExpiresAt"=now()+interval '1 minute',"userId"='owner',"deviceId"='${device}'; UPDATE devices SET enabled=true,kind='local'; UPDATE local_computer_reviews SET "seenAt"=now(),"expiresAt"=now()+interval '1 minute'; DELETE FROM computer_run_bindings`)
    }
    const results = await Promise.all([decideLocalComputerReview(pool, 'owner', id, digest, true), decideLocalComputerReview(pool, 'owner', id, digest, true)])
    assert.equal(results.filter(Boolean).length, 1)
    assert.equal(await decideLocalComputerReview(pool, 'owner', id, digest, true), false)
  } finally {
    await pool.end()
    console.log(`Retained local review test schema: ${schema}`)
    await admin.end()
  }
})
