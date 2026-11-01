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

  await t.test('reactions: one per person per message, only on messages they can see', async () => {
    const { reactionsFor, setReaction, visibleGroupMessages } = await import('../lib/reactions')
    const chatMessage = randomUUID()
    await pool.query(`insert into coordinator_messages (id,"userId","botId",position,message) values ($1,$2,$3,1,'{"role":"assistant","content":"hi"}')`, [chatMessage, owner, bot])
    const group = randomUUID(), groupMessage = randomUUID()
    await pool.query(`insert into conversations (id,"workspaceId",kind,title,"createdBy") values ($1,$2,'group','Team',$3)`, [group, ws.id, owner])
    await pool.query(`insert into conversation_members ("conversationId","memberType","memberId",role) values ($1,'user',$2,'owner'),($1,'user',$3,'member')`, [group, owner, other])
    await pool.query(`insert into conversation_messages (id,"conversationId",position,"authorType","authorId",body) values ($1,$2,1,'bot',$3,'Done')`, [groupMessage, group, bot])

    assert.equal(await setReaction(owner, chatMessage, '❤️'), true)
    assert.equal(await setReaction(owner, chatMessage, '👍'), true, 'a second reaction replaces the first')
    assert.equal(await setReaction(other, chatMessage, '👍'), false, "someone else's bot chat")
    assert.deepEqual(await reactionsFor(owner, [chatMessage]), { [chatMessage]: [{ emoji: '👍', count: 1, mine: true }] })

    assert.equal(await setReaction(owner, groupMessage, '🎉'), true)
    assert.equal(await setReaction(other, groupMessage, '🎉'), true)
    assert.deepEqual(await reactionsFor(other, [groupMessage]), { [groupMessage]: [{ emoji: '🎉', count: 2, mine: true }] })
    assert.equal(await setReaction(other, groupMessage, null), true)
    assert.deepEqual(await reactionsFor(owner, [groupMessage]), { [groupMessage]: [{ emoji: '🎉', count: 1, mine: true }] })

    await pool.query(`update conversation_members set "leftAt"=now() where "conversationId"=$1 and "memberId"=$2`, [group, other])
    assert.equal(await setReaction(other, groupMessage, '👍'), false, 'a person who left the group')
    assert.deepEqual(await visibleGroupMessages(other, [groupMessage]), [])
    assert.deepEqual(await visibleGroupMessages(owner, [groupMessage, chatMessage]), [groupMessage])
  })

  await t.test("置顶 and 通知 per chat, only for the person's own bots; 资料库 from the bot's threads", async () => {
    const { chatMuted, chatPreferences, setChatPreference } = await import('../lib/chat-preferences')
    assert.equal(await setChatPreference(owner, bot, { pinned: true }), true)
    assert.equal(await setChatPreference(owner, bot, { muted: true }), true, 'a second change keeps the first')
    assert.equal(await setChatPreference(owner, null, { muted: true }), true, 'the Coordinator')
    assert.equal(await setChatPreference(other, bot, { pinned: true }), false, "someone else's bot")
    assert.deepEqual(await chatPreferences(owner), { [bot]: { pinned: true, muted: true }, coordinator: { pinned: false, muted: true } })
    assert.deepEqual(await chatPreferences(other), {})
    assert.equal(await chatMuted(owner, bot), true)
    assert.equal(await chatMuted(owner, sibling), false)
    await setChatPreference(owner, bot, { muted: false })
    assert.equal(await chatMuted(owner, bot), false)

    const artifact = randomUUID()
    await pool.query(`insert into artifacts (id,"userId",kind,title,"runId") values ($1,$2,'markdown','Release notes',$3),($4,$2,'html','Other bot page',$5)`,
      [artifact, owner, mine, randomUUID(), dispatched])
    const page = await mobileBot(owner, ws.id, bot)
    assert.deepEqual(page.library.map(item => [item.id, item.title, item.kind, item.version]), [[artifact, 'Release notes', 'markdown', 1]])
    assert.deepEqual([page.pinned, page.muted], [true, false])
    assert.deepEqual((await mobileBot(other, ws.id, bot)).library, [])
  })
})
