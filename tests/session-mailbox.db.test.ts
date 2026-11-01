// The personal mailbox store against the schema main's migrations build
// (drizzle/20261101020100_personal_mailbox_schema.sql), which is the shape
// production has had since 2026-10-25. Real SQL, real store, no fixtures for
// the mailbox tables themselves.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedUser, seedWorkspace, seedBot } from './support/workspace-admin-db'

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
  await t.test('Bot envelope and notification commit together; retries and ACK do not create another wake', async () => {
    const owner = await seedUser(pool, 'mailbox-notification')
    const ws = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
    const senderBot = await seedBot(pool, ws.id, owner), receiverBot = await seedBot(pool, ws.id, owner)
    const store = new SessionMailbox(pool, ws.id)
    const sender = await store.conversation(owner, 'bot', senderBot)
    const receiver = await store.conversation(owner, 'bot', receiverBot)
    const input = { to: receiver.mailboxId, key: randomUUID(), text: 'Private original peer body' }
    const first = await store.send(sender, input)
    assert.equal((await store.send(sender, input)).duplicate, true)
    const wake = () => pool.query('select "botId",kind,tier,payload from coordinator_events where "userId"=$1 and "dedupeKey"=$2', [owner, `mailbox:${first.id}`])
    const event = await wake()
    assert.equal(event.rowCount, 1)
    assert.equal(event.rows[0].botId, receiverBot)
    assert.equal(event.rows[0].kind, 'run_report')
    assert.equal(event.rows[0].tier, 'attention')
    const packet = JSON.parse(event.rows[0].payload.text)
    assert.equal(packet.authority, 'coordination_data_only')
    assert.equal(packet.source.origin, 'peer_agent')
    assert.ok(!packet.untrustedData.body.includes(input.text))
    assert.match(packet.untrustedData.body, /mailbox_inbox/)
    const inbox = await store.inbox(receiver)
    assert.equal(inbox.messages[0].acknowledgedAt, null)
    await store.ack(receiver, [first.id])
    await store.sent(sender)
    assert.equal((await wake()).rowCount, 1)
    let checks = 0
    const revoked = new SessionMailbox(pool, ws.id, async () => { if (++checks === 2) throw new Error('Authority revoked before commit') })
    const failedKey = randomUUID()
    await assert.rejects(revoked.send(sender, { ...input, key: failedKey }), /revoked before commit/)
    assert.equal((await pool.query('select id from run_messages where "senderMailboxId"=$1 and "dedupeKey"=$2', [sender.mailboxId, failedKey])).rowCount, 0)
    assert.equal((await pool.query('select id from coordinator_events where "userId"=$1', [owner])).rowCount, 1, 'Rolled-back envelope left a notification')
  })
  await t.test('fresh keys without replyTo cannot extend an automatic chain; exhausted mail stays unread and a user root remains available', async () => {
    const owner = await seedUser(pool, 'mailbox-chain')
    const ws = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
    const store = new SessionMailbox(pool, ws.id)
    const actors = await Promise.all([seedBot(pool, ws.id, owner), seedBot(pool, ws.id, owner)].map(async bot => store.conversation(owner, 'bot', await bot)))
    let last
    for (let depth = 0; depth <= 8; depth++) {
      const from = actors[depth % 2], to = actors[1 - depth % 2]
      last = await store.send({ ...from, notificationDepth: depth - 1 }, { to: to.mailboxId, key: randomUUID(), text: `Peer reply ${depth}` })
    }
    assert.equal((await pool.query('select id from coordinator_events where "userId"=$1', [owner])).rowCount, 8)
    const held = (await pool.query('select "mailboxWakeDepth","deliveredAt","acknowledgedAt" from run_messages where id=$1', [last!.id])).rows[0]
    assert.equal(held.mailboxWakeDepth, 8)
    assert.equal(held.deliveredAt, null)
    assert.equal(held.acknowledgedAt, null)
    assert.equal((await pool.query('select id from coordinator_events where "dedupeKey"=$1', [`mailbox:${last!.id}`])).rowCount, 0)
    const fresh = await store.send({ ...actors[0], notificationDepth: -1 }, { to: actors[1].mailboxId, key: randomUUID(), text: 'Unrelated authenticated owner request' })
    assert.equal((await pool.query('select id from coordinator_events where "dedupeKey"=$1', [`mailbox:${fresh.id}`])).rowCount, 1)
  })
})
