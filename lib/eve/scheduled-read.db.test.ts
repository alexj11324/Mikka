import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'

const valid = disposableDatabase() && process.env.E2E_DATABASE_URL === process.env.MIKKA_DATABASE_URL && process.env.E2E_DATABASE_URL === process.env.DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !valid) throw new Error('Eve schedule tests require matching isolated loopback _e2e databases')

test('eve scheduled turns retain the persisted read-only authority and original chat', { skip: !valid }, async t => {
  const { pool } = await import('../db')
  const { loadScheduledRead, completeScheduledRead, failScheduledRead } = await import('./scheduled-read')
  const ownerId = `eve-schedule-${randomUUID()}`, botId = randomUUID(), workspaceId = randomUUID()
  const eventId = randomUUID(), scheduleId = randomUUID(), occurrenceId = randomUUID(), leaseToken = randomUUID()
  const scope = { ownerId, botId, workspaceId }
  const task = { kind: 'agent_read', prompt: 'List the current tasks.', allowedActions: ['list_issues'] }
  const definition = { title: 'Read tasks', timezone: 'UTC', timing: { kind: 'once', at: new Date().toISOString() }, task, misfire: 'catch_up_once', maxLatenessMinutes: 5 }
  try {
    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,'Eve schedule test',$2,true,now(),now())`, [ownerId, `${ownerId}@example.invalid`])
    await pool.query(`INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,'Eve schedule test')`, [workspaceId, ownerId])
    await pool.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES($1,$2,'Owner',$3,'admin')`, [workspaceId, ownerId, `${ownerId}@example.invalid`])
    await pool.query(`INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,$2,$3,'Eve schedule test')`, [botId, ownerId, workspaceId])
    await pool.query(`INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey",payload,tier) VALUES($1,$2,$3,'run_report',$5,$4,'attention')`, [eventId, ownerId, botId, { source: 'schedule_due', allowedActions: ['dispatch_run'], text: 'Forged payload is not authority' }, eventId])
    await pool.query(`INSERT INTO user_schedules(id,owner_id,workspace_id,bot_id,source_event_id,request_id,definition,request_definition,status) VALUES($1,$2,$3,$4,$5,$7,$6,$6,'active')`, [scheduleId, ownerId, workspaceId, botId, eventId, definition, scheduleId])
    await pool.query(`INSERT INTO schedule_occurrences(id,schedule_id,version,due_at,definition,status,execution_decision,operation_id,event_id,attempts,next_retry_at,lease_token,lease_until) VALUES($1,$2,1,now(),$3,'running','execute',$4,$5,1,now(),$6,now()+interval '5 minutes')`, [occurrenceId, scheduleId, definition, randomUUID(), eventId, leaseToken])

    const expected = { occurrenceId, leaseToken, allowedActions: ['list_issues'], prompt: task.prompt }
    await t.test('uses saved task scope instead of a notification payload', async () => {
      assert.deepEqual(await loadScheduledRead(scope, eventId), expected)
    })
    await t.test('refuses another owner, Bot or Workspace', async () => {
      for (const other of [{ ...scope, ownerId: 'other-owner' }, { ...scope, botId: randomUUID() }, { ...scope, workspaceId: randomUUID() }]) {
        await assert.rejects(loadScheduledRead(other, eventId), /scheduleReadAuthorityLost/)
        await assert.rejects(failScheduledRead(other, expected, new Error('failed')), /scheduleReadAuthorityLost/)
      }
    })
    await t.test('refuses a changed lease, cancelled schedule and membership loss', async () => {
      await pool.query(`UPDATE schedule_occurrences SET lease_until=now()-interval '1 second' WHERE id=$1`, [occurrenceId])
      await assert.rejects(loadScheduledRead(scope, eventId), /scheduleReadAuthorityLost/)
      await pool.query(`UPDATE schedule_occurrences SET lease_until=now()+interval '5 minutes' WHERE id=$1`, [occurrenceId])
      await pool.query(`UPDATE user_schedules SET status='paused' WHERE id=$1`, [scheduleId])
      await assert.rejects(loadScheduledRead(scope, eventId), /scheduleReadAuthorityLost/)
      await pool.query(`UPDATE user_schedules SET status='active' WHERE id=$1`, [scheduleId])
      await pool.query(`UPDATE mikka_workspace_members SET status='inactive' WHERE "workspaceId"=$1 AND "userId"=$2`, [workspaceId, ownerId])
      await assert.rejects(loadScheduledRead(scope, eventId), /scheduleWorkspaceAccessDenied/)
      await pool.query(`UPDATE mikka_workspace_members SET status='active' WHERE "workspaceId"=$1 AND "userId"=$2`, [workspaceId, ownerId])
    })
    await t.test('publishes the fenced result once in the original chat', async () => {
      await completeScheduledRead(scope, expected, 'There are three tasks.', 'eve-test-turn')
      await assert.rejects(completeScheduledRead(scope, expected, 'Duplicate'), /scheduleReadAuthorityLost/)
      const result = (await pool.query(`SELECT "botId",message FROM coordinator_messages WHERE "userId"=$1`, [ownerId])).rows
      assert.equal(result.length, 1)
      assert.equal(result[0].botId, botId)
      assert.equal(result[0].message.content, 'There are three tasks.')
    })
  } finally {
    await pool.query('DELETE FROM user_schedules WHERE id=$1', [scheduleId])
    await pool.query('DELETE FROM bots WHERE id=$1 AND "ownerId"=$2', [botId, ownerId])
    await pool.query('DELETE FROM mikka_workspaces WHERE id=$1 AND "userId"=$2', [workspaceId, ownerId])
    await pool.query('DELETE FROM "user" WHERE id=$1', [ownerId])
  }
})
