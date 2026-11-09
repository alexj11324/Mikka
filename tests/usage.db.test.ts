// 用量 read model (lib/usage/read.ts) against a real PostgreSQL.
import assert from 'node:assert/strict'
import test from 'node:test'
import { dbUrl, seedAgent, seedBot, seedIssue, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db'

test('workspace usage', { skip: !dbUrl }, async t => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 2 })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { WorkspaceError } = await import('../lib/workspace-access')
  const { workspaceUsage } = await import('../lib/usage/read')
  const { listBotRunRoots, listIssueRunChains } = await import('../lib/run-chain')
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
    return id
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

  await t.test('retries, answered questions and continuations count one thread while every run adds time', async () => {
    const solo = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }])
    const first = await seedBot(pool, solo.id, admin, 'Original bot')
    const next = await seedBot(pool, solo.id, admin, 'Continuation bot')
    const root = await run(admin, agent, first, '2026-10-02T09:00:00Z', '2026-10-02T09:00:00Z', '2026-10-02T10:00:00Z')
    const retry = await run(admin, agent, first, '2026-10-03T09:00:00Z', '2026-10-03T09:00:00Z', '2026-10-03T10:00:00Z')
    await pool.query('update agent_runs set "retryOf"=$2 where id=$1', [retry, root])
    const answer = await run(admin, agent, next, '2026-10-04T09:00:00Z', '2026-10-04T09:00:00Z', '2026-10-04T10:00:00Z')
    await pool.query('update agent_runs set "questionContinuation"=$2 where id=$1', [answer, JSON.stringify({ originRunId: retry })])
    const continued = await run(admin, agent, next, '2026-10-05T09:00:00Z', '2026-10-05T09:00:00Z', '2026-10-05T10:00:00Z')
    await pool.query('update agent_runs set "continuesRunId"=$2 where id=$1', [continued, answer])
    const usage = await workspaceUsage(admin, solo.id, '2026-10')
    assert.deepEqual(usage.totals, { threads: 1, seconds: 14_400 })
    assert.deepEqual(usage.bots.map(bot => [bot.name, bot.threads, bot.seconds]), [['Original bot', 1, 7200], ['Continuation bot', 0, 7200]])
    assert.deepEqual(usage.daily.filter(day => day.threads), [{ date: '2026-10-02', threads: 1 }])
  })

  await t.test('an October retry of a September thread adds run time without a new thread', async () => {
    const solo = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }])
    const bot = await seedBot(pool, solo.id, admin, 'Retried last month')
    const root = await run(admin, agent, bot, '2026-09-30T20:00:00Z', '2026-09-30T20:00:00Z', '2026-09-30T21:00:00Z')
    const retry = await run(admin, agent, bot, '2026-10-03T09:00:00Z', '2026-10-03T09:00:00Z', '2026-10-03T10:00:00Z')
    await pool.query('update agent_runs set "retryOf"=$2 where id=$1', [retry, root])
    const october = await workspaceUsage(admin, solo.id, '2026-10')
    assert.deepEqual(october.totals, { threads: 0, seconds: 3600 })
    assert.equal(october.daily.reduce((sum, day) => sum + day.threads, 0), 0)
    const september = await workspaceUsage(admin, solo.id, '2026-09')
    assert.deepEqual(september.totals, { threads: 1, seconds: 3600 })
  })

  await t.test('cross-workspace ancestry is rejected without exposing its root or changing either run', async () => {
    for (const rootDate of ['2026-09-30T09:00:00Z', '2026-10-01T09:00:00Z']) {
      const originWorkspace = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }])
      const currentWorkspace = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }])
      const origin = await seedBot(pool, originWorkspace.id, admin, 'Private original bot')
      const current = await seedBot(pool, currentWorkspace.id, admin, 'Current bot')
      const issue = await seedIssue(pool, admin, originWorkspace.id)
      const root = await run(admin, agent, origin, rootDate, rootDate, rootDate)
      const retry = await run(admin, agent, current, '2026-10-03T09:00:00Z', '2026-10-03T09:00:00Z', '2026-10-03T10:00:00Z')
      const tx = await pool.connect()
      try {
        await tx.query('BEGIN')
        await tx.query('update agent_runs set "issueId"=$2 where id=$1', [root, issue])
        assert.equal((await listIssueRunChains(tx, issue, [admin], 20))[0].rootRunId, root)
        await assert.rejects(tx.query('update agent_runs set "issueId"=$2,"retryOf"=$3 where id=$1', [retry, issue, root]),
          { code: '23514', message: 'taskWorkspaceMismatch' })
      } finally {
        await tx.query('ROLLBACK')
        tx.release()
      }
      assert.deepEqual((await pool.query('SELECT "issueId","retryOf" FROM agent_runs WHERE id=ANY($1::uuid[]) ORDER BY id', [[root, retry]])).rows,
        [{ issueId: null, retryOf: null }, { issueId: null, retryOf: null }], 'a rejected cross-workspace task binding leaves both runs unchanged')
      await assert.rejects(pool.query('update agent_runs set "retryOf"=$2 where id=$1', [retry, root]),
        { code: '23514', message: 'taskWorkspaceMismatch' })
      assert.deepEqual((await pool.query('SELECT "issueId","retryOf" FROM agent_runs WHERE id=ANY($1::uuid[]) ORDER BY id', [[root, retry]])).rows,
        [{ issueId: null, retryOf: null }, { issueId: null, retryOf: null }], 'task-free runs cannot acquire a parent from another workspace either')
      assert.deepEqual((await listBotRunRoots(pool, [current], at('2026-10-01'), at('2026-11-01'))).map(row => row.rootRunId), [retry], 'only the independent current-workspace root is returned')
      const usage = await workspaceUsage(admin, currentWorkspace.id, '2026-10')
      assert.deepEqual(usage.totals, { threads: 1, seconds: 3600 })
      assert.deepEqual(usage.bots.map(bot => bot.id), [current])
      assert.equal(usage.daily.reduce((sum, day) => sum + day.threads, 0), 1)
    }
  })

  await t.test('usage ancestry accepts 64 parent links and refuses a 65th', async () => {
    const bot = await seedBot(pool, ws.id, admin)
    const root = await run(admin, agent, bot, '2026-10-01T09:00:00Z', null, null)
    let previous = root
    for (let depth = 1; depth <= 64; depth++) {
      const child = await run(admin, agent, bot, '2026-10-02T09:00:00Z', null, null)
      await pool.query('update agent_runs set "retryOf"=$2 where id=$1', [child, previous])
      previous = child
    }
    assert.deepEqual((await listBotRunRoots(pool, [bot], at('2026-10-01'), at('2026-11-01'))).map(row => row.rootRunId), [root])
    const over = await run(admin, agent, bot, '2026-10-03T09:00:00Z', null, null)
    await pool.query('update agent_runs set "retryOf"=$2 where id=$1', [over, previous])
    await assert.rejects(listBotRunRoots(pool, [bot], at('2026-10-01'), at('2026-11-01')), /runChainDepthExceeded/)
  })

  await t.test('the ancestry query seeds only the requested month instead of the entire bot history', async () => {
    const bot = await seedBot(pool, ws.id, admin)
    await pool.query(`insert into agent_runs (id,"userId","agentId","botId",status,"createdAt")
      select gen_random_uuid(),$1,$2,$3,'succeeded','2025-01-01T00:00:00Z'::timestamptz from generate_series(1,2000)`, [admin, agent, bot])
    const root = await run(admin, agent, bot, '2026-10-02T09:00:00Z', null, null)
    let captured: { text: string; values?: unknown[] } | undefined
    const query = { query: async (text: string, values?: unknown[]) => { captured = { text, values }; return pool.query(text, values) } }
    assert.deepEqual((await listBotRunRoots(query, [bot], at('2026-10-01'), at('2026-11-01'))).map(row => row.rootRunId), [root])
    interface PlanNode { 'Node Type': string; 'Actual Rows'?: number; Plans?: PlanNode[] }
    const plan = await pool.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${captured!.text}`, captured!.values)
    const findRecursive = (node: PlanNode): PlanNode | undefined => node['Node Type'] === 'Recursive Union' ? node : node.Plans?.map(findRecursive).find(Boolean)
    const recursive = findRecursive(plan.rows[0]['QUERY PLAN'][0].Plan)
    assert.ok(recursive, 'the same bounded ancestry resolver supplies the query')
    assert.equal(recursive.Plans?.[0]['Actual Rows'], 1, 'unrelated historical runs never enter the recursive seed')
  })

  await t.test('invalid cyclic ancestry is refused instead of producing a thread count', async () => {
    const solo = await seedWorkspace(pool, admin, [{ userId: admin, role: 'admin' }])
    const bot = await seedBot(pool, solo.id, admin)
    const a = await run(admin, agent, bot, '2026-10-02T09:00:00Z', null, null)
    const b = await run(admin, agent, bot, '2026-10-03T09:00:00Z', null, null)
    await pool.query('update agent_runs set "retryOf"=$2 where id=$1', [a, b])
    await pool.query('update agent_runs set "retryOf"=$2 where id=$1', [b, a])
    await assert.rejects(workspaceUsage(admin, solo.id, '2026-10'), /runChainDepthExceeded/)
  })

  await t.test('members see their own bots only; outsiders are refused', async () => {
    const usage = await workspaceUsage(member, ws.id, '2026-10')
    assert.equal(usage.scope, 'own')
    assert.deepEqual(usage.bots.map(bot => bot.name), ['Frontend'])
    await assert.rejects(workspaceUsage(stranger, ws.id, '2026-10'), (error: unknown) => error instanceof WorkspaceError && error.code === 'workspaceAccessDenied')
    await assert.rejects(workspaceUsage(admin, ws.id, '2026-13'))
  })
})
