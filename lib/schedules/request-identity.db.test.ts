import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedBot, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'
import type { Definition } from './contract'

test('schedule request identity survives bot removal through the production command path', { skip: !dbUrl, timeout: 60_000 }, async t => {
  // Existing clock-based suites deliberately sweep every due schedule. Own the
  // whole database so their future clock cannot execute these real-time rows.
  const database = `schedule_request_${randomUUID().replaceAll('-', '')}_e2e`
  const target = new URL(dbUrl!)
  target.pathname = `/${database}`
  const admin = new Pool({ connectionString: dbUrl, max: 1 })
  await admin.query(`CREATE DATABASE ${database}`)
  const previous = Object.fromEntries(['E2E_DATABASE_URL', 'DATABASE_URL', 'MIKKA_DATABASE_URL'].map(key => [key, process.env[key]]))
  for (const key of Object.keys(previous)) process.env[key] = target.href
  const fixture = new Pool({ connectionString: target.href })
  let closeRuntime = async () => {}
  t.after(async () => {
    await closeRuntime()
    await fixture.end()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await admin.query(`DROP DATABASE ${database}`)
    await admin.end()
  })
  execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/setup-e2e-db.mjs'], { env: process.env, stdio: 'pipe' })
  const app = await import('../db/request-scope')
  const { workspacePool } = await import('../workspace-db')
  const { coordinatorWakeTransport } = await import('../coordinator/wake-after-commit')
  // Observe only database work. This official seam prevents starting a model turn.
  const originalWake = coordinatorWakeTransport.wake
  coordinatorWakeTransport.wake = async () => undefined
  const runtime = await import('./runtime')
  const { deleteWorkspaceData } = await import('../workspace-admin/general')
  closeRuntime = async () => {
    coordinatorWakeTransport.wake = originalWake
    await Promise.all([app.pool.end(), workspacePool.end()])
  }
  const owner = await seedUser(fixture, 'schedule-request-identity')
  const definition = (): Definition => ({ title: 'Persisted reminder', timezone: 'UTC',
    timing: { kind: 'once', at: new Date(Date.now() + 60_000).toISOString() },
    task: { kind: 'reminder', text: 'Retained result' }, misfire: 'catch_up_once', maxLatenessMinutes: 5 })
  async function source(botId: string) {
    const id = randomUUID()
    await fixture.query(`INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey",payload,tier)
      VALUES($1::uuid,$2,$3,'user_message',$1::text,'{"text":"Schedule this reminder"}','attention')`, [id, owner, botId])
    return id
  }
  await t.test('a null-bot producer has no Workspace and cannot create against an orphan key', async () => {
    assert.deepEqual(await runtime.scheduleActor(owner, null), { ownerId: owner, botId: null, workspaceId: null })
    await assert.rejects(runtime.executeScheduleCommand(owner, null, undefined,
      { action: 'create', requestId: 'same-provider-call', definition: definition() }), /scheduleWorkspaceRequired/)
  })
  await t.test('deleting a Workspace succeeds after two of its bots used the same provider request ID', async () => {
    const workspace = await seedWorkspace(fixture, owner, [{ userId: owner, role: 'admin' }])
    const bots = await Promise.all([seedBot(fixture, workspace.id, owner), seedBot(fixture, workspace.id, owner)])
    const input = { action: 'create' as const, requestId: 'same-provider-call', definition: definition() }
    const created = await Promise.all(bots.map(async bot => runtime.executeScheduleCommand(owner, bot, await source(bot), input))) as Array<{ schedule: { id: string } }>
    assert.equal(new Set(created.map(row => row.schedule.id)).size, 2, 'request IDs are scoped to each bot')
    assert.ok(created.every(row => !Object.hasOwn(row.schedule, 'request_origin')), 'internal request anchors stay out of tool replies')
    const deleted = await deleteWorkspaceData(owner, workspace.id, workspace.name)
    assert.equal(deleted.deleted.bots, 2)
    assert.equal((await fixture.query('SELECT 1 FROM user_schedules WHERE workspace_id=$1', [workspace.id])).rowCount, 0)
  })
  await t.test('removing both bot anchors retains distinct schedules and their existing authority', async () => {
    const workspace = await seedWorkspace(fixture, owner, [{ userId: owner, role: 'admin' }])
    const bots = await Promise.all([seedBot(fixture, workspace.id, owner), seedBot(fixture, workspace.id, owner)])
    const reader = await seedBot(fixture, workspace.id, owner)
    const input = { action: 'create' as const, requestId: 'same-provider-call', definition: definition() }
    const created = await Promise.all(bots.map(async bot => runtime.executeScheduleCommand(owner, bot, await source(bot), input))) as Array<{ schedule: { id: string }; replayed: boolean }>
    const ids = created.map(row => row.schedule.id)
    assert.equal((await runtime.executeScheduleCommand(owner, bots[0], await source(bots[0]), input) as { schedule: { id: string } }).schedule.id, ids[0])
    await fixture.query('DELETE FROM bots WHERE id=ANY($1::uuid[])', [bots])
    const { rows } = await fixture.query('SELECT id,owner_id,workspace_id,bot_id,visibility FROM user_schedules WHERE id=ANY($1::uuid[]) ORDER BY id', [ids])
    assert.equal(rows.length, 2, 'bot deletion preserves both persisted reminders')
    assert.ok(rows.every(row => row.owner_id === owner && row.workspace_id === workspace.id && row.bot_id === null && row.visibility === 'workspace'))
    const listed = await runtime.executeScheduleCommand(owner, reader, undefined, { action: 'list' }) as { schedules: Array<{ id: string }> }
    assert.deepEqual(listed.schedules.map(row => row.id).sort(), ids.sort())
    assert.ok(listed.schedules.every(row => !Object.hasOwn(row, 'request_origin')))
    for (const row of rows) {
      await runtime.executeScheduleCommand(owner, reader, await source(reader), { action: 'cancel', scheduleId: row.id, version: 1 })
      const history = await runtime.executeScheduleCommand(owner, reader, undefined, { action: 'history', scheduleId: row.id }) as { occurrences: unknown[] }
      assert.deepEqual(history.occurrences, [])
    }
  })
  await t.test('the request-origin migration preserves existing rows and NULL-anchor uniqueness', async t => {
    const owner = await seedUser(fixture, 'schedule-origin-upgrade')
    const workspace = await seedWorkspace(fixture, owner, [{ userId: owner, role: 'admin' }])
    const bots = await Promise.all([seedBot(fixture, workspace.id, owner), seedBot(fixture, workspace.id, owner)])
    const schema = `schedule_origin_${randomUUID().replaceAll('-', '')}`
    const client = await fixture.connect()
    t.after(async () => {
      await client.query('RESET search_path')
      await client.query(`DROP SCHEMA ${schema} CASCADE`)
      client.release()
    })
    await client.query(`CREATE SCHEMA ${schema}`)
    await client.query(`SET search_path TO ${schema},public`)
    for (const file of ['20261031002606_user_schedules.sql', '20261111200000_schedules.sql']) {
      await client.query(await readFile(new URL(`../../drizzle/${file}`, import.meta.url), 'utf8'))
    }
    const definition: Definition = { title: 'Retained definition', timezone: 'UTC', timing: { kind: 'once', at: '2030-01-01T00:00:00Z' },
      task: { kind: 'reminder', text: 'Retained body' }, misfire: 'skip', maxLatenessMinutes: 5 }
    const ids = [randomUUID(), randomUUID(), randomUUID()]
    const insert = (id: string, bot: string | null, request: string) => client.query(`INSERT INTO user_schedules
      (id,owner_id,workspace_id,bot_id,visibility,source_event_id,request_id,definition,request_definition,status)
      VALUES($1,$2,$3,$4,'workspace',$5,$6,$7,$7,'paused')`, [id, owner, workspace.id, bot, randomUUID(), request, definition])
    await insert(ids[0], bots[0], 'same-request')
    await insert(ids[1], bots[1], 'same-request')
    await insert(ids[2], null, 'legacy-coordinator-request')
    await fixture.query('DELETE FROM bots WHERE id=$1', [bots[0]])
    const before = (await client.query('SELECT * FROM user_schedules ORDER BY id')).rows
    await client.query(await readFile(new URL('../../drizzle/20261112030504_freeze_schedule_request_origin.sql', import.meta.url), 'utf8'))
    const migrated = (await client.query('SELECT * FROM user_schedules ORDER BY id')).rows
    assert.deepEqual(migrated.map(({ request_origin: _origin, ...row }) => row), before, 'the upgrade preserves every existing field and row')
    for (const row of migrated) assert.equal(row.request_origin, row.bot_id ? `bot:${row.bot_id}` : `retained:${row.id}`)
    await fixture.query('DELETE FROM bots WHERE id=$1', [bots[1]])
    const after = (await client.query('SELECT * FROM user_schedules ORDER BY id')).rows
    assert.equal(after.length, 3)
    assert.ok(after.every(row => row.bot_id === null))
    assert.deepEqual(after.map(row => row.request_origin), migrated.map(row => row.request_origin), 'SET NULL cannot rewrite request identity')
    await insert(randomUUID(), null, 'new-coordinator-request')
    await assert.rejects(insert(randomUUID(), null, 'new-coordinator-request'), { code: '23505' })
    await assert.rejects(client.query('UPDATE user_schedules SET request_origin=$2 WHERE id=$1', [ids[0], 'coordinator']), { code: '23514' })
  })
})
