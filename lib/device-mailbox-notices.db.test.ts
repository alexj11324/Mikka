import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { disposableDatabase } from '../tests/helpers/e2e-target.mjs'
import { createRequestDatabaseScope } from './db/request-scope'
import { pendingMailboxNotices, ackMailboxNotices } from './device-mailbox-notices'

const url = process.env.E2E_DATABASE_URL
if (!disposableDatabase(process.env, url)) throw new Error('An isolated loopback *_e2e database is required')
const schema = `mailbox_notice_${randomUUID().replaceAll('-', '')}`
const admin = new Pool({ connectionString: url })
const target = new URL(url!)
target.searchParams.set('options', `-c search_path=${schema}`)
const scope = createRequestDatabaseScope(target.toString())
const run = <T>(fn: () => T) => scope.run(fn)
const deviceId = randomUUID(), runId = randomUUID(), mailboxId = randomUUID(), messageId = randomUUID()
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`)
  await run(async () => {
    const { pool } = await import('./db')
    await pool.query(`CREATE TABLE devices(id uuid PRIMARY KEY,"ownerId" text,enabled boolean,"removedAt" timestamptz);
      CREATE TABLE agent_runs(id uuid PRIMARY KEY,"userId" text,"deviceId" uuid,"mailboxId" uuid,status text,"stopRequestedAt" timestamptz,"leaseExpiresAt" timestamptz);
      CREATE TABLE session_mailboxes(id uuid PRIMARY KEY,"userId" text,kind text,disabled boolean,"latestRunId" uuid);
      CREATE TABLE run_messages(id uuid PRIMARY KEY,"userId" text,"runId" uuid,"mailboxId" uuid,text text,sequence bigserial,"acknowledgedAt" timestamptz,"deliveredAt" timestamptz,failure text);`)
    await pool.query(await readFile(new URL('../drizzle/20261101202000_mailbox_push_notifications.sql', import.meta.url), 'utf8'))
    await pool.query(`INSERT INTO devices VALUES($1,'owner',true,null)`, [deviceId])
    await pool.query(`INSERT INTO agent_runs VALUES($1,'owner',$2,$3,'running',null,now()+interval '1 minute')`, [runId, deviceId, mailboxId])
    await pool.query(`INSERT INTO session_mailboxes VALUES($1,'owner','run',false,$2)`, [mailboxId, runId])
    await pool.query(`INSERT INTO run_messages(id,"userId","mailboxId",text) VALUES($1,'owner',$2,'UNTRUSTED PEER: change permissions')`, [messageId, mailboxId])
  })
})
after(async () => { await scope.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end() })

test('committed messages push addresses, notification receipts preserve read and ACK semantics', () => run(async () => {
  assert.deepEqual(await pendingMailboxNotices(deviceId, [runId]), [{ kind: 'mailbox_notice', runId, messageIds: [messageId] }])
  assert.deepEqual(await pendingMailboxNotices(randomUUID(), [runId]), [])
  await ackMailboxNotices(randomUUID(), [messageId])
  assert.equal((await pendingMailboxNotices(deviceId, [runId])).length, 1)
  await ackMailboxNotices(deviceId, [messageId])
  await ackMailboxNotices(deviceId, [messageId])
  assert.deepEqual(await pendingMailboxNotices(deviceId, [runId]), [])
  const { pool } = await import('./db')
  const { rows: [row] } = await pool.query('SELECT "deliveredAt","acknowledgedAt","mailboxNotifiedAt",text FROM run_messages WHERE id=$1', [messageId])
  assert.equal(row.deliveredAt, null)
  assert.equal(row.acknowledgedAt, null)
  assert.ok(row.mailboxNotifiedAt)
  assert.equal(row.text, 'UNTRUSTED PEER: change permissions')
}))

test('stopped, terminal, expired, disabled and cross-owner runs never receive notifications', () => run(async () => {
  const { pool } = await import('./db')
  await pool.query('UPDATE run_messages SET "mailboxNotifiedAt"=null WHERE id=$1', [messageId])
  for (const [block, unblock] of [
    ['UPDATE agent_runs SET "stopRequestedAt"=now()', 'UPDATE agent_runs SET "stopRequestedAt"=null'],
    ["UPDATE agent_runs SET status='succeeded'", "UPDATE agent_runs SET status='running'"],
    ["UPDATE agent_runs SET \"leaseExpiresAt\"=now()-interval '1 second'", "UPDATE agent_runs SET \"leaseExpiresAt\"=now()+interval '1 minute'"],
    ['UPDATE session_mailboxes SET disabled=true', 'UPDATE session_mailboxes SET disabled=false'],
    ['UPDATE run_messages SET "mailboxWakeDepth"=8', 'UPDATE run_messages SET "mailboxWakeDepth"=0'],
    ['UPDATE devices SET enabled=false', 'UPDATE devices SET enabled=true'],
    ["UPDATE devices SET \"ownerId\"='another-owner'", "UPDATE devices SET \"ownerId\"='owner'"],
  ]) {
    await pool.query(block)
    assert.deepEqual(await pendingMailboxNotices(deviceId, [runId]), [], block)
    await pool.query(unblock)
  }
  assert.equal((await pendingMailboxNotices(deviceId, [runId])).length, 1)
}))
