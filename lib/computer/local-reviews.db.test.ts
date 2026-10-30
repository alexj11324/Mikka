import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { decideLocalComputerReview, pendingLocalComputerReviews } from './local-reviews'
import { localComputerAuthority } from './local-authority'
import { isE2eTarget } from '../../tests/helpers/e2e-target.mjs'

const url = process.env.COMPUTER_TEST_DATABASE_URL ?? process.env.E2E_DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !url) throw new Error('Computer database test URL required')
test('local decisions bind owner, device, live run and exact digest, and cannot be replayed', { skip: !url }, async () => {
  const target = new URL(url!)
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && (target.pathname === '/computer_test' || isE2eTarget(url)))
  const schema = `local_review_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: url })
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` })
  const [device, run, id] = [randomUUID(), randomUUID(), randomUUID()]
  const digest = createHash('sha256').update('fixture').digest('hex')
  try {
    await pool.query(`CREATE TABLE devices (id uuid PRIMARY KEY,"ownerId" text NOT NULL,name text NOT NULL,kind text NOT NULL,enabled boolean NOT NULL);
      CREATE TABLE bots (id uuid PRIMARY KEY,"ownerId" text,"workspaceId" uuid);
      CREATE TABLE workspace_computer_policies ("workspaceId" uuid PRIMARY KEY,permission text,version int);
      CREATE TABLE agent_runs (id uuid PRIMARY KEY,"deviceId" uuid,"userId" text,status text,"stopRequestedAt" timestamptz,"leaseExpiresAt" timestamptz,"botId" uuid);
      CREATE TABLE computer_run_bindings ("runId" uuid PRIMARY KEY);
      CREATE TABLE local_computer_reviews (id uuid PRIMARY KEY,"deviceId" uuid,"runId" uuid,"userId" text,target text,display text,call jsonb,digest text,"expiresAt" timestamptz,"seenAt" timestamptz,decision boolean)`)
    await pool.query("INSERT INTO devices VALUES ($1,'owner','fixture','local',true)", [device])
    const botId = randomUUID(), workspaceId = randomUUID()
    await pool.query("INSERT INTO bots VALUES ($1,'owner',$2)", [botId, workspaceId])
    await pool.query("INSERT INTO agent_runs VALUES ($1,$2,'owner','running',NULL,now()+interval '1 minute',$3)", [run, device, botId])
    // No policy row: the daemon receives allow and runs each call without a review.
    assert.deepEqual(await localComputerAuthority(pool, 'owner', device, run), { botId, ownerId: 'owner', workspaceId, permission: 'allow', policyVersion: 0 })
    assert.equal(await localComputerAuthority(pool, 'other', device, run), null)
    await pool.query("INSERT INTO workspace_computer_policies VALUES ($1,'allow',3)", [workspaceId])
    assert.deepEqual(await localComputerAuthority(pool, 'owner', device, run), { botId, ownerId: 'owner', workspaceId, permission: 'allow', policyVersion: 3 })
    await pool.query("UPDATE workspace_computer_policies SET permission='deny',version=4 WHERE \"workspaceId\"=$1", [workspaceId])
    assert.equal(await localComputerAuthority(pool, 'owner', device, run), null)
    // A row written before the 2026-10-30 migration still reads as allow.
    await pool.query("UPDATE workspace_computer_policies SET permission='ask',version=5 WHERE \"workspaceId\"=$1", [workspaceId])
    assert.deepEqual(await localComputerAuthority(pool, 'owner', device, run), { botId, ownerId: 'owner', workspaceId, permission: 'allow', policyVersion: 5 })
    // Legacy compatibility only: a daemon that received an 'ask' grant before
    // this change can still have its queued reviews decided by the owner.
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
    ]) {
      await pool.query(update)
      assert.equal(await decideLocalComputerReview(pool, 'owner', id, digest, true), false)
      await pool.query(`UPDATE agent_runs SET "stopRequestedAt"=NULL,"leaseExpiresAt"=now()+interval '1 minute',"userId"='owner',"deviceId"='${device}'; UPDATE devices SET enabled=true,kind='local'; UPDATE local_computer_reviews SET "seenAt"=now(),"expiresAt"=now()+interval '1 minute'`)
    }
    const results = await Promise.all([decideLocalComputerReview(pool, 'owner', id, digest, true), decideLocalComputerReview(pool, 'owner', id, digest, true)])
    assert.equal(results.filter(Boolean).length, 1)
    assert.equal(await decideLocalComputerReview(pool, 'owner', id, digest, true), false)
    const otherReview = randomUUID()
    await pool.query(`INSERT INTO local_computer_reviews VALUES ($1,$2,$3,'owner','target',NULL,'{"name":"click"}',$4,now()+interval '1 minute',now(),NULL)`, [otherReview, device, run, digest])
    await pool.query('INSERT INTO computer_run_bindings VALUES ($1)', [run])
    assert.equal(await decideLocalComputerReview(pool, 'owner', otherReview, digest, true), false)
  } finally {
    await pool.end()
    console.log(`Retained local review test schema: ${schema}`)
    await admin.end()
  }
})
