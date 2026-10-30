// 设置 › Bot › 线程列表 (WS-07) against a real PostgreSQL: scoping, titles, status and paging.
import assert from 'node:assert/strict'
import test from 'node:test'
import { dbUrl, seedAgent, seedBot, seedIssue, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('bot thread list', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 3 })
  const { WorkspaceError } = await import('../lib/workspace-access')
  const botAdmin = await import('../lib/workspace-admin/bots')
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
  const privateIssue = await seedIssue(pool, owner)
  await pool.query(`update issues set title='Owner private task' where id=$1`, [privateIssue])
  const runs: string[] = []
  for (let i = 0; i < 5; i++) {
    const id = await seedRun(pool, { userId: owner, agentId: agent, botId: bot, status: i === 4 ? 'queued' : i === 3 ? 'running' : i === 2 ? 'failed' : 'succeeded', issueId: i === 0 ? privateIssue : null })
    await pool.query(`update agent_runs set prompt=$2, "createdAt"=now() - ($3 || ' minutes')::interval where id=$1`, [id, `Chat ${i}\nmore`, String(10 - i)])
    runs.push(id)
  }
  // Same createdAt for two rows: keyset must not skip or repeat ties.
  await pool.query(`update agent_runs set "createdAt"=(select "createdAt" from agent_runs where id=$1) where id=$2`, [runs[1], runs[2]])
  await seedRun(pool, { userId: outsider, agentId: await seedAgent(pool, outsider), botId: foreignBot })

  await t.test('owner sees everything with titles and running/done status', async () => {
    const page = await botAdmin.listBotThreadsFor(owner, ws.id, { botId: bot })
    assert.deepEqual(page.bot, { id: bot, name: 'Reviewer' })
    assert.equal(page.threads.length, 5)
    assert.equal(page.nextCursor, null)
    const byId = new Map(page.threads.map(row => [row.id, row]))
    assert.equal(byId.get(runs[0])!.title, 'Owner private task')
    assert.equal(byId.get(runs[3])!.title, 'Chat 3')
    assert.deepEqual(runs.map(id => byId.get(id)!.status), ['done', 'done', 'done', 'running', 'running'])
    assert.equal(page.threads[0].id, runs[4], 'newest first')
    assert.ok(!Number.isNaN(Date.parse(page.threads[0].updatedAt)))
  })

  await t.test('another member sees the list but no private titles or prompts', async () => {
    const page = await botAdmin.listBotThreadsFor(member, ws.id, { botId: bot })
    assert.equal(page.threads.length, 5)
    assert.ok(page.threads.every(row => row.title === null))
  })

  await t.test('keyset paging covers every thread exactly once, including ties', async () => {
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const page: Awaited<ReturnType<typeof botAdmin.listBotThreadsFor>> = await botAdmin.listBotThreadsFor(owner, ws.id, { botId: bot, limit: 2, cursor })
      assert.ok(page.threads.length <= 2)
      seen.push(...page.threads.map(row => row.id))
      cursor = page.nextCursor
    } while (cursor)
    assert.deepEqual([...seen].sort(), [...runs].sort())
    assert.equal(new Set(seen).size, runs.length)
  })

  await t.test('scoping: other workspace bot, outsiders, suspended members and bad cursors are refused', async () => {
    await rejects(botAdmin.listBotThreadsFor(owner, ws.id, { botId: foreignBot }), 'botNotFound')
    await rejects(botAdmin.listBotThreadsFor(outsider, ws.id, { botId: bot }), 'workspaceAccessDenied')
    await rejects(botAdmin.listBotThreadsFor(gone, ws.id, { botId: bot }), 'workspaceAccessDenied')
    await rejects(botAdmin.listBotThreadsFor(owner, ws.id, { botId: bot, cursor: 'garbage' }), 'validationGeneric')
    await assert.rejects(botAdmin.listBotThreadsFor(owner, ws.id, { botId: bot, limit: 500 }))
  })

  await t.test('defaults expose the three model groups', async () => {
    const options = await botAdmin.botDefaultOptions(ws.id)
    assert.deepEqual(options.modelGroups.map(group => group.id), ['mikka', 'codex', 'claude'])
    assert.deepEqual(options.models, ['mikka', 'codex', 'claude'])
  })
})
