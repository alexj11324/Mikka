// 用量 read model (lib/usage/read.ts) against a real PostgreSQL.
import assert from 'node:assert/strict'
import test from 'node:test'
import { dbUrl, seedAgent, seedBot, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('workspace usage', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { WorkspaceError } = await import('../lib/workspace-access')
  const { workspaceUsage } = await import('../lib/usage/read')
  t.after(async () => { await Promise.all([pool.end(), appPool.end(), workspacePool.end()]) })

  const admin = await seedUser(pool, 'admin'), member = await seedUser(pool, 'member'), stranger = await seedUser(pool, 'stranger')
  const ws = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }, { userId: member, role: 'member' }])
  const other = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }])
  const adminBot = await seedBot(pool, ws.id, admin, 'Coordinator helper'), memberBot = await seedBot(pool, ws.id, member, 'Frontend'), elsewhere = await seedBot(pool, other.id, admin)
  const agent = await seedAgent(pool, admin), memberAgent = await seedAgent(pool, member)
  const at = (iso: string) => new Date(iso)
  const run = async (userId: string, agentId: string, botId: string, created: string, started: string | null, finished: string | null) => {
    const id = await seedRun(pool, { userId, agentId, botId, startedAt: started ? at(started) : null, finishedAt: finished ? at(finished) : null })
    await pool.query('update agent_runs set "createdAt"=$2 where id=$1', [id, at(created)])
  }
  await run(admin, agent, adminBot, '2026-10-02T10:00:00Z', '2026-10-02T10:00:00Z', '2026-10-02T11:00:00Z')
  await run(admin, agent, adminBot, '2026-10-02T12:00:00Z', '2026-10-02T12:00:00Z', '2026-10-02T12:30:00Z')
  // Started in September, finished in October: only the October half hour counts, and the thread belongs to September.
  await run(member, memberAgent, memberBot, '2026-09-30T23:30:00Z', '2026-09-30T23:30:00Z', '2026-10-01T00:30:00Z')
  await run(member, memberAgent, memberBot, '2026-10-05T09:00:00Z', null, null)
  await run(admin, agent, elsewhere, '2026-10-03T09:00:00Z', '2026-10-03T09:00:00Z', '2026-10-03T10:00:00Z')

  await t.test('admins see every bot and member in the workspace for the month', async () => {
    const usage = await workspaceUsage(admin, ws.id, '2026-10')
    assert.equal(usage.scope, 'workspace')
    assert.deepEqual(usage.bots.map(bot => [bot.name, bot.threads, bot.seconds]), [['Coordinator helper', 2, 5400], ['Frontend', 1, 1800]])
    assert.deepEqual(usage.totals, { threads: 3, seconds: 7200 })
    assert.equal(usage.members.length, 2)
    assert.equal(usage.daily.length, 31)
    assert.deepEqual(usage.daily.filter(day => day.threads).map(day => [day.date, day.threads]), [['2026-10-02', 2], ['2026-10-05', 1]])
    const september = await workspaceUsage(admin, ws.id, '2026-09')
    assert.deepEqual(september.bots.find(bot => bot.name === 'Frontend')?.seconds, 1800)
  })

  await t.test('a thread counts in the month it started; its run time counts in the months it ran', async () => {
    // A bot whose only thread started in September and ran into October: 0 新线程 and an hour of run time in October.
    const solo = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }])
    const carried = await seedBot(pool, solo.id, admin, 'Carried over')
    await run(admin, agent, carried, '2026-09-30T23:00:00Z', '2026-09-30T23:00:00Z', '2026-10-01T01:00:00Z')
    const october = await workspaceUsage(admin, solo.id, '2026-10')
    assert.deepEqual(october.bots.map(bot => [bot.name, bot.threads, bot.seconds]), [['Carried over', 0, 3600]])
    const september = await workspaceUsage(admin, solo.id, '2026-09')
    assert.deepEqual(september.bots.map(bot => [bot.name, bot.threads, bot.seconds]), [['Carried over', 1, 3600]])
    // The 新线程 total is the sum of the daily bars, in every month.
    for (const usage of [october, september, await workspaceUsage(admin, ws.id, '2026-10')]) {
      assert.equal(usage.totals.threads, usage.daily.reduce((sum, day) => sum + day.threads, 0))
    }
  })

  await t.test('members see their own bots only; outsiders are refused', async () => {
    const usage = await workspaceUsage(member, ws.id, '2026-10')
    assert.equal(usage.scope, 'own')
    assert.deepEqual(usage.bots.map(bot => bot.name), ['Frontend'])
    await assert.rejects(workspaceUsage(stranger, ws.id, '2026-10'), (error: unknown) => error instanceof WorkspaceError && error.code === 'workspaceAccessDenied')
    await assert.rejects(workspaceUsage(admin, ws.id, '2026-13'))
  })
})
