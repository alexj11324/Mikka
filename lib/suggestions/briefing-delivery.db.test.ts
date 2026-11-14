import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { seedCoordinator } from '../../tests/support/coordinator-bot'
import { seedUser } from '../../tests/support/workspace-admin-db'
import { localClock } from './briefing'

const target = process.env.E2E_DATABASE_URL
const enabled = Boolean(target && disposableDatabase(process.env, target) && process.env.MIKKA_DATABASE_URL === target && process.env.DATABASE_URL === target)
if (process.env.REQUIRE_DB === '1') assert.ok(enabled, 'matching isolated loopback *_e2e databases are required')

test('cron, lazy suggestion reads and app connection deliver each briefing through the committed event', { skip: !enabled, timeout: 60_000 }, async t => {
  const direct: string[] = [], committed: string[] = [], scheduled: Promise<unknown>[] = []
  const wakeReady = new Map<string, () => void>()
  const next = await import('next/server')
  t.mock.module('next/server', { namedExports: { ...next, after: (work: () => Promise<unknown>) => { scheduled.push(work()) } } })
  t.mock.module('../coordinator/wake', { namedExports: { wakeCoordinator: async (userId: string) => { direct.push(userId) } } })
  const provider = await import('../composio')
  t.mock.module('../composio', { namedExports: { ...provider, getComposio: () => null } })
  t.mock.module('../coordinator/decide', { namedExports: { decide: async () => null } })
  let visitor: string | undefined
  t.mock.module('../api-auth', { namedExports: { getApiSession: async () => visitor ? { user: { id: visitor } } : null } })
  const [{ pool }, { workspacePool }, { coordinatorWakeTransport }, { bootstrapSuggestions }, cron, suggestions] = await Promise.all([
    import('../db'), import('../workspace-db'), import('../coordinator/wake-after-commit'), import('./sources'),
    import('../../app/api/cron/briefings/route'), import('../../app/api/suggestions/route'),
  ])
  const people: string[] = []
  // Exercise both daily paths well inside the same local day at any CI hour.
  const timeZone = ['UTC', 'Asia/Tokyo', 'America/Los_Angeles'].find(zone => {
    const { hour } = localClock(zone, new Date())
    return hour >= 9 && hour < 21
  })
  assert.ok(timeZone)
  const secret = process.env.CRON_SECRET
  process.env.CRON_SECRET = 'local-briefing-route-fixture'
  t.after(async () => {
    if (secret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = secret
    delete coordinatorWakeTransport.wake
    for (const table of ['coordinator_events', 'briefings', 'suggestions', 'user_time_zones']) await pool.query(`DELETE FROM ${table} WHERE "userId"=ANY($1::text[])`, [people])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [people])
    await Promise.all([pool.end(), workspacePool.end()])
  })
  coordinatorWakeTransport.wake = async userId => {
    const row = await pool.query('SELECT id FROM coordinator_events WHERE "userId"=$1 AND kind=$2', [userId, 'daily_briefing'])
    assert.equal(row.rowCount, 1, 'the event is committed before dispatch')
    committed.push(userId)
    wakeReady.get(userId)?.()
  }
  async function person(withSuggestion = true) {
    const owner = await seedUser(pool, 'briefing-delivery')
    people.push(owner)
    await seedCoordinator(owner)
    if (withSuggestion) {
      await pool.query('INSERT INTO suggestions(id,"userId",source,"externalId",action,title,shown,"decidedBy","occurredAt") VALUES($1,$2,$3,$4,$5,$6,true,$7,now())',
        [randomUUID(), owner, 'github', randomUUID(), 'review', 'Review fixture', 'rule'])
    }
    return owner
  }
  const daily = await person(), empty = await person(false), lazy = await person(), first = await person()
  const waits = [daily, lazy, first].map(owner => new Promise<void>(resolve => { wakeReady.set(owner, resolve) }))
  const { recordTimeZone } = await import('./store')
  await recordTimeZone(daily, timeZone)
  await recordTimeZone(empty, timeZone)
  const cronRequest = new Request('http://localhost/api/cron/briefings', { headers: { authorization: 'Bearer local-briefing-route-fixture' } })
  const result = await (await cron.GET(cronRequest)).json()
  assert.equal(result.pushed, 1)
  assert.equal(result.empty, 1)
  assert.equal((await (await cron.GET(cronRequest)).json()).pushed, 0)
  visitor = lazy
  const list = new Request('http://localhost/api/suggestions?tz=' + encodeURIComponent(timeZone))
  assert.equal((await suggestions.GET(list)).status, 200)
  assert.equal((await suggestions.GET(list)).status, 200)
  await bootstrapSuggestions(first, 'composio', timeZone)
  await bootstrapSuggestions(first, 'composio', timeZone)
  await Promise.all(waits)
  await Promise.all(scheduled)
  assert.deepEqual(committed.sort(), [daily, lazy, first].sort())
  assert.deepEqual(direct, [], 'callers do not re-dispatch a queued or deduplicated briefing')
})
