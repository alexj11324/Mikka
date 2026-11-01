// The iOS bot page (GET /api/mobile/bots/<id>) against a real PostgreSQL: whose threads, PRs and 例行 it shows.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { dbUrl, seedAgent, seedBot, seedIssue, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('mobile bot page', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const { mobileBot } = await import('../lib/mobile-threads')
  const { pool: appPool } = await import('../lib/db')
  t.after(async () => { await Promise.all([pool.end(), appPool.end()]) })

  const owner = await seedUser(pool, 'owner'), other = await seedUser(pool, 'other')
  const ws = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }])
  const bot = await seedBot(pool, ws.id, owner, 'Reviewer'), sibling = await seedBot(pool, ws.id, owner, 'Writer')
  const agent = await seedAgent(pool, owner)
  const issue = await seedIssue(pool, owner)
  const pr = (n: number, state: string, title?: string) => ({ url: `https://github.com/acme/app/pull/${n}`, state, ...(title ? { title } : {}) })
  await pool.query(`update issues set title='Fix login', content=$2 where id=$1`, [issue, { type: 'doc', attrs: { mikka: { pullRequests: [pr(7, 'open', 'Login fix'), pr(8, 'merged'), pr(9, 'closed')] } } }])

  const mine = await seedRun(pool, { userId: owner, agentId: agent, botId: bot, issueId: issue, status: 'succeeded' })
  await seedRun(pool, { userId: owner, agentId: agent, botId: sibling })
  const dispatched = await seedRun(pool, { userId: owner, agentId: agent, botId: null })
  const mcp = await seedRun(pool, { userId: owner, agentId: agent, botId: null })
  await pool.query(`update agent_runs set source='mcp' where id=$1`, [mcp])
  await seedRun(pool, { userId: other, agentId: await seedAgent(pool, other), botId: bot })

  const schedule = async (botId: string | null, status: string, title: string) => {
    const id = randomUUID()
    const definition = { title, timezone: 'UTC', timing: { kind: 'once', at: '2030-01-01T09:00:00Z' }, task: { kind: 'reminder', text: 'x' }, misfire: 'skip', maxLatenessMinutes: 60 }
    await pool.query(`insert into user_schedules (id,owner_id,workspace_id,bot_id,source_event_id,request_id,definition,request_definition,status,next_at)
      values ($1,$2,$3,$4,$5,$6,$7,$7,$8,'2030-01-01T09:00:00Z')`, [id, owner, ws.id, botId, randomUUID(), randomUUID(), definition, status])
    return id
  }
  const active = await schedule(bot, 'active', 'Daily review')
  await schedule(bot, 'cancelled', 'Old')
  await schedule(sibling, 'active', 'Writer digest')
  const coordinatorSchedule = await schedule(null, 'paused', 'Morning brief')

  await t.test("a bot's own threads, its task's open and merged PRs, its live schedules", async () => {
    const page = await mobileBot(owner, ws.id, bot)
    assert.deepEqual(page.threads.map(thread => thread.id), [mine])
    assert.deepEqual(page.pullRequests, [
      { url: pr(7, 'open').url, number: 7, title: 'Login fix', group: 'review' },
      { url: pr(8, 'merged').url, number: 8, title: 'Fix login', group: 'merged' },
    ])
    assert.deepEqual(page.schedules.map(row => [row.id, row.title, row.status]), [[active, 'Daily review', 'active']])
  })

  await t.test("the Coordinator's: what it dispatched, not MCP runs or bots'", async () => {
    const page = await mobileBot(owner, ws.id, null)
    assert.deepEqual(page.threads.map(thread => thread.id), [dispatched])
    assert.deepEqual(page.pullRequests, [])
    assert.deepEqual(page.schedules.map(row => [row.id, row.status]), [[coordinatorSchedule, 'paused']])
  })

  await t.test("another person sees none of the owner's", async () => {
    const page = await mobileBot(other, ws.id, bot)
    assert.ok(!page.threads.some(thread => thread.id === mine))
    assert.deepEqual([page.pullRequests, page.schedules], [[], []])
  })
})
