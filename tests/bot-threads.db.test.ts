// 设置 › Bot › 线程列表 (WS-07) against a real PostgreSQL: scoping, titles, status and paging.
import assert from 'node:assert/strict'
import test from 'node:test'
import { dbUrl, seedAgent, seedBot, seedIssue, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('bot thread list', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const { WorkspaceError } = await import('../lib/workspace-access')
  const botAdmin = await import('../lib/workspace-admin/bots')
  const { botThreadPublicId } = await import('../lib/workspace-admin/bot-threads')
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  t.after(async () => { await Promise.all([pool.end(), appPool.end(), workspacePool.end()]) })
  const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof WorkspaceError && error.code === code)

  const owner = await seedUser(pool, 'owner'), member = await seedUser(pool, 'member'), outsider = await seedUser(pool, 'outsider'), gone = await seedUser(pool, 'gone')
  const ws = await seedWorkspace(pool, owner, [{ userId: owner, role: 'admin' }, { userId: member, role: 'member' }, { userId: gone, role: 'member', status: 'suspended' }])
  const other = await seedWorkspace(pool, outsider, [{ userId: outsider, role: 'admin' }])
  const bot = await seedBot(pool, ws.id, owner, 'Reviewer')
  const foreignBot = await seedBot(pool, other.id, outsider)
  const agent = await seedAgent(pool, owner)
  const issueA = await seedIssue(pool, owner), issueB = await seedIssue(pool, owner)
  await pool.query(`update issues set title='Owner private task' where id=$1`, [issueA])
  await pool.query(`update issues set title='Second task' where id=$1`, [issueB])
  // run(user, issue, status, prompt, minutes ago created, minutes ago updated, lastReply minutes ago)
  const run = async (userId: string, issueId: string | null, status: string, prompt: string, created: number, updated: number, reply: number | null = null) => {
    const id = await seedRun(pool, { userId, agentId: agent, botId: bot, status, issueId })
    await pool.query(`update agent_runs set prompt=$2, "createdAt"=now() - ($3 || ' minutes')::interval, "updatedAt"=now() - ($4 || ' minutes')::interval,
      "lastReplyAt"=case when $5::text is null then null else now() - ($5 || ' minutes')::interval end where id=$1`, [id, prompt, String(created), String(updated), reply === null ? null : String(reply)])
    return id
  }
  // Task A: two runs → one row, latest run running, activity = newest of the two.
  await run(owner, issueA, 'succeeded', 'a1', 60, 50)
  const latestA = await run(owner, issueA, 'running', 'a2', 40, 30)
  // Task B: one finished run; its lastReplyAt (5) is newer than updatedAt (45).
  await run(owner, issueB, 'succeeded', 'b1', 50, 45, 5)
  // Owner's chat: three runs, opening line comes from the first; latest finished.
  await run(owner, null, 'failed', 'Chat opening\nmore', 90, 85)
  await run(owner, null, 'running', 'Chat middle', 80, 75)
  await run(owner, null, 'succeeded', 'Chat latest', 20, 10)
  // Member's chat: same activity as owner's chat to exercise keyset ties.
  await run(member, null, 'queued', 'Member private ask', 15, 10)
  await pool.query(`update agent_runs set "updatedAt"=(select max("updatedAt") from agent_runs where "botId"=$1 and "issueId" is null and "userId"=$2) where "botId"=$1 and "userId"=$3`, [bot, owner, member])
  await seedRun(pool, { userId: outsider, agentId: await seedAgent(pool, outsider), botId: foreignBot })
  await pool.query(`update "user" set image='/api/avatars/' || id || '/abc' where id=$1`, [owner])
  const tid = (key: string) => botThreadPublicId(bot, key)
  const T = { a: tid(`issue:${issueA}`), b: tid(`issue:${issueB}`), ownerChat: tid(`chat:${owner}`), memberChat: tid(`chat:${member}`) }
  const allThreads = Object.values(T)

  await t.test('runs aggregate per thread: latest status, last activity, opening title, href', async () => {
    const page = await botAdmin.listBotThreadsFor(owner, ws.id, { botId: bot })
    assert.deepEqual(page.bot, { id: bot, name: 'Reviewer' })
    assert.equal(page.summary.totalThreads, 4)
    assert.equal(page.nextCursor, null)
    assert.deepEqual(page.threads.map(row => row.threadId).sort(), [...allThreads].sort())
    const by = new Map(page.threads.map(row => [row.threadId, row]))
    assert.deepEqual(by.get(T.a), { threadId: T.a, initiator: { id: owner, name: by.get(T.a)!.initiator.name, avatarUrl: `/api/avatars/${owner}/abc` }, title: 'Owner private task', status: 'running', lastActivityAt: by.get(T.a)!.lastActivityAt, canOpen: true, href: `/?issue=${issueA}&thread=${latestA}` })
    assert.equal(by.get(T.b)!.status, 'done')
    assert.equal(page.threads[0].threadId, T.b, 'lastReplyAt counts as activity; most recent first')
    assert.equal(page.summary.lastActivityAt, page.threads[0].lastActivityAt)
    const chat = by.get(T.ownerChat)!
    assert.deepEqual([chat.title, chat.status, chat.canOpen, chat.href], ['Chat opening', 'done', true, `/?bot=${bot}`])
    const memberChat = by.get(T.memberChat)!
    assert.deepEqual([memberChat.title, memberChat.status, memberChat.canOpen, memberChat.href], [null, 'running', false, null])
    assert.ok(Date.parse(by.get(T.a)!.lastActivityAt) > Date.parse(chat.lastActivityAt) - 25 * 60_000)
    assert.ok(!JSON.stringify(page).includes('Member private ask'))
  })

  await t.test('another member: no task titles, no owner prompt, only own chat opens', async () => {
    const page = await botAdmin.listBotThreadsFor(member, ws.id, { botId: bot })
    assert.equal(page.summary.totalThreads, 4)
    const by = new Map(page.threads.map(row => [row.threadId, row]))
    for (const id of [T.a, T.b, T.ownerChat]) assert.deepEqual([by.get(id)!.title, by.get(id)!.canOpen, by.get(id)!.href], [null, false, null], id)
    assert.deepEqual([by.get(T.memberChat)!.title, by.get(T.memberChat)!.href], ['Member private ask', `/?bot=${bot}`])
    assert.ok(!JSON.stringify(page).includes('Chat opening'))
    // Invisible tasks: no task reference at all (no id in threadId, href or anywhere), initiator still shown.
    const json = JSON.stringify(page)
    for (const issueId of [issueA, issueB]) assert.ok(!json.includes(issueId), 'issue id leaked')
    for (const id of [T.a, T.b, T.ownerChat]) assert.equal(by.get(id)!.initiator.id, owner)
    assert.ok(by.get(T.a)!.initiator.name, 'initiator name shown with a null title')
    assert.equal(by.get(T.memberChat)!.initiator.avatarUrl, null)
    // Cursors carry the opaque id only.
    const first = await botAdmin.listBotThreadsFor(member, ws.id, { botId: bot, limit: 1 })
    assert.ok(first.nextCursor && !Buffer.from(first.nextCursor, 'base64url').toString().match(/issue:|chat:/))
  })

  await t.test('keyset paging by threadId covers every thread exactly once, including ties', async () => {
    for (const limit of [1, 2, 3]) {
      const seen: string[] = []
      let cursor: string | null = null
      do {
        const page: Awaited<ReturnType<typeof botAdmin.listBotThreadsFor>> = await botAdmin.listBotThreadsFor(owner, ws.id, { botId: bot, limit, cursor })
        assert.ok(page.threads.length <= limit)
        seen.push(...page.threads.map(row => row.threadId))
        cursor = page.nextCursor
      } while (cursor)
      assert.deepEqual([...seen].sort(), [...allThreads].sort(), `limit ${limit}`)
    }
  })

  await t.test('empty bot: zero threads and null last activity', async () => {
    const empty = await seedBot(pool, ws.id, owner, 'Idle')
    const page = await botAdmin.listBotThreadsFor(owner, ws.id, { botId: empty })
    assert.deepEqual([page.threads, page.summary, page.nextCursor], [[], { totalThreads: 0, lastActivityAt: null }, null])
  })

  await t.test('scoping: other workspace bot, outsiders, suspended members and bad cursors are refused', async () => {
    await rejects(botAdmin.listBotThreadsFor(owner, ws.id, { botId: foreignBot }), 'botNotFound')
    await rejects(botAdmin.listBotThreadsFor(outsider, ws.id, { botId: bot }), 'workspaceAccessDenied')
    await rejects(botAdmin.listBotThreadsFor(gone, ws.id, { botId: bot }), 'workspaceAccessDenied')
    await rejects(botAdmin.listBotThreadsFor(owner, ws.id, { botId: bot, cursor: 'garbage' }), 'validationGeneric')
    await assert.rejects(botAdmin.listBotThreadsFor(owner, ws.id, { botId: bot, limit: 500 }))
  })

  await t.test('existing bot defaults remain compatible', async () => {
    const options = await botAdmin.botDefaultOptions(ws.id)
    assert.deepEqual(options.models, ['mikka', 'codex', 'claude'])
  })
})
