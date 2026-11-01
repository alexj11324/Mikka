// The personal mailbox store against the schema main's migrations build
// (drizzle/20261101020100_personal_mailbox_schema.sql), which is the shape
// production has had since 2026-10-25. Real SQL, real store, no fixtures for
// the mailbox tables themselves.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('session mailbox schema and store', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  t.after(() => pool.end())
  const { SessionMailbox } = await import('../lib/session-mailbox')

  await t.test('schema matches production', async () => {
    const { rows } = await pool.query(`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns
      where table_schema=current_schema() and ((table_name='session_mailboxes') or (table_name='run_messages' and column_name in ('runId','mailboxId','senderMailboxId','replyTo','dedupeKey','acknowledgedAt','failure','origin','sequence'))
        or (table_name='agent_runs' and column_name='mailboxId') or (table_name='coordinator_events' and column_name='sequence'))`)
    const col = (table: string, name: string) => rows.find(r => r.table_name === table && r.column_name === name)
    assert.equal(col('session_mailboxes', 'workspaceId')?.data_type, 'text')
    assert.equal(col('session_mailboxes', 'wakeBudget')?.column_default, '0')
    assert.equal(col('run_messages', 'runId')?.is_nullable, 'YES')
    assert.equal(col('run_messages', 'origin')?.column_default, "'owner'::text")
    assert.match(col('run_messages', 'sequence')?.column_default, /mikka_mailbox_sequence/)
    assert.match(col('coordinator_events', 'sequence')?.column_default, /mikka_mailbox_sequence/)
    assert.equal(col('agent_runs', 'mailboxId')?.data_type, 'uuid')
    const { rows: checks } = await pool.query(`select conname, pg_get_constraintdef(oid) def from pg_constraint where conrelid='session_mailboxes'::regclass`)
    const def = (name: string) => checks.find(c => c.conname === name)?.def
    assert.match(def('session_mailboxes_kind_check'), /'run'.*'coordinator'.*'bot'.*'group'/)
    assert.match(def('session_mailboxes_wakeBudget_check'), />= 0.*<= 10/)
    assert.match(def('session_mailboxes_latestRunId_fkey'), /REFERENCES agent_runs\(id\) ON DELETE SET NULL/)
  })

  await t.test('a run sends to its coordinator mailbox and a retry is a duplicate', async () => {
    const owner = await seedUser(pool, 'mailbox-owner')
    const ws = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
    const device = randomUUID(), agent = randomUUID(), runId = randomUUID()
    await pool.query(`insert into devices (id,name,"ownerId",kind,enabled) values ($1,'cloud',$2,'cloud',true)`, [device, owner])
    await pool.query(`insert into agents (id,"userId",harness,name) values ($1,$2,'codex','a')`, [agent, owner])
    await pool.query(`insert into agent_runs (id,"agentId","userId","deviceId",status,"leaseExpiresAt") values ($1,$2,$3,$4,'running',now()+interval '10 minutes')`, [runId, agent, owner, device])
    const mailbox = new SessionMailbox(pool, ws.id)
    const sender = await mailbox.run(owner, runId)
    const coordinator = await mailbox.conversation(owner, 'coordinator')
    assert.equal((await mailbox.conversation(owner, 'coordinator')).mailboxId, coordinator.mailboxId)
    const key = randomUUID()
    const first = await mailbox.send(sender, { to: coordinator.mailboxId, key, text: 'hello' })
    const again = await mailbox.send(sender, { to: coordinator.mailboxId, key, text: 'hello' })
    assert.equal(again.id, first.id)
    assert.equal(again.duplicate, true)
    const { rows: [message] } = await pool.query(`select "runId","mailboxId",origin,sequence from run_messages where "senderMailboxId"=$1`, [sender.mailboxId])
    assert.equal(message.runId, null)
    assert.equal(message.mailboxId, coordinator.mailboxId)
    assert.equal(message.origin, 'peer')
    assert.ok(BigInt(message.sequence) > BigInt(0))
    const { rows: [box] } = await pool.query(`select "latestRunId" from session_mailboxes where id=$1`, [sender.mailboxId])
    assert.equal(box.latestRunId, runId)
    const view = await mailbox.ownerView(owner, coordinator.mailboxId)
    assert.equal(view.messages.length, 1)
  })
})
