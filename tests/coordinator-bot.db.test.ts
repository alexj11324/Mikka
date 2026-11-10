// The Coordinator is an ordinary bot row (lib/coordinator/coordinator-bot.ts).
// Real PostgreSQL: older unattributed chat/history moves onto that row once,
// safely twice; admitted executions retain their frozen null-Bot authority.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { PoolClient } from 'pg'
import type { ModelMessage } from 'ai'
import { normalizeRepository } from '@mikka/protocol/repository'
import { dbUrl, seedAgent, seedBot, seedIssue, seedPersonalWorkspace, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db'
import { ALLOWED_MODEL, seedAllowedModel } from './support/allowed-model'
import { connectGitHub, githubAppStub } from './support/github-app-stub'
import { isolateCoordinatorWakes } from './support/coordinator-wake'

const SECRET = 'isolated-ci-coordinator-backfill-fixture-key-0000'

test('the Coordinator is an ordinary bot row', { skip: !dbUrl }, async t => {
  const previousSecret = process.env.BETTER_AUTH_SECRET
  process.env.BETTER_AUTH_SECRET = SECRET
  const wakes = await isolateCoordinatorWakes(t)
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 4 })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const { withTaskWorkspace } = await import('../lib/task-workspace')
  const { observePoolCommits } = await import('../lib/db/commit-effects')
  observePoolCommits(pool)
  const bots = await import('../lib/coordinator/coordinator-bot')
  const store = await import('../lib/coordinator/store')
  const { preserveMessageSources } = await import('../lib/coordinator/message-safety')
  const { promptMessages } = await import('../lib/coordinator/context')
  const { factoryStore } = await import('../lib/factory/server')
  const users: string[] = []
  t.after(async () => {
    await wakes.flush()
    if (previousSecret === undefined) delete process.env.BETTER_AUTH_SECRET
    else process.env.BETTER_AUTH_SECRET = previousSecret
    for (const statement of [
      'DELETE FROM coordinator_messages WHERE "userId" = ANY($1)', 'DELETE FROM coordinator_sessions WHERE "userId" = ANY($1)',
      'DELETE FROM factory_tasks WHERE "userId" = ANY($1)',
      'DELETE FROM byos_native_runs WHERE "runId" IN (SELECT id FROM agent_runs WHERE "userId" = ANY($1))',
      'DELETE FROM computer_run_bindings WHERE "ownerId" = ANY($1)',
      'DELETE FROM coordinator_events WHERE "userId" = ANY($1)', 'DELETE FROM agent_runs WHERE "userId" = ANY($1)',
      'DELETE FROM agents WHERE "userId" = ANY($1)', 'DELETE FROM issues WHERE "userId" = ANY($1)',
      'DELETE FROM devices WHERE "ownerId" = ANY($1)',
      'DELETE FROM model_order_entries WHERE "ownerId" = ANY($1)', 'DELETE FROM model_order_settings WHERE "ownerId" = ANY($1)',
      'DELETE FROM byos_bindings WHERE "ownerId" = ANY($1)', 'DELETE FROM byos_connections WHERE "ownerId" = ANY($1)',
      'DELETE FROM repository_settings WHERE "userId" = ANY($1)', 'DELETE FROM github_repository_installations WHERE "userId" = ANY($1)',
      'DELETE FROM account WHERE "userId" = ANY($1)',
      'DELETE FROM bot_model_choices WHERE "ownerId" = ANY($1)', 'DELETE FROM chat_preferences WHERE "userId" = ANY($1)',
      'DELETE FROM user_schedules WHERE owner_id = ANY($1)', 'DELETE FROM agent_kit_heads WHERE owner_id = ANY($1)',
      'DELETE FROM coordinator_bots WHERE "ownerId" = ANY($1)', 'DELETE FROM bot_desktops WHERE "ownerId" = ANY($1)', 'DELETE FROM bots WHERE "ownerId" = ANY($1)',
      'DELETE FROM mikka_team_members WHERE "userId" = ANY($1)', 'DELETE FROM mikka_teams WHERE "workspaceId" IN (SELECT id FROM mikka_workspaces WHERE "userId" = ANY($1))',
      'DELETE FROM mikka_workspace_members WHERE "userId" = ANY($1)', 'DELETE FROM mikka_workspaces WHERE "userId" = ANY($1)',
      'DELETE FROM "user" WHERE id = ANY($1)',
    ]) await pool.query(statement, [users])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  const person = async (label: string) => {
    const id = await seedUser(pool, label)
    users.push(id)
    const workspaceId = await seedPersonalWorkspace(pool, id)
    return { id, workspaceId }
  }
  const messageRows = (userId: string) => pool.query<{ botId: string | null; position: number; text: string }>(
    `SELECT "botId",position,message->>'content' AS text FROM coordinator_messages WHERE "userId"=$1 ORDER BY "botId" NULLS FIRST,position`, [userId])
  const sourceEvent = async (userId: string, payload: Record<string, unknown> = { text: 'Synthetic owner request' }) => {
    const id = randomUUID()
    await pool.query(`INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload,"deliveredAt") VALUES($1,$2,'user_message',$3,$4,now())`, [id, userId, `backfill:${id}`, JSON.stringify(payload)])
    return id
  }
  const route = (userId: string, issueId: string, sourceEventId: string, tx?: PoolClient) => factoryStore.route(userId, {
    issueId, sourceEventId, eventId: randomUUID(), rationale: 'Synthetic backfill scope regression',
  }, tx)
  const waitBlockedBy = async (pid: number) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      if ((await pool.query('SELECT exists(SELECT 1 FROM pg_stat_activity WHERE $1::int=any(pg_blocking_pids(pid))) AS blocked', [pid])).rows[0].blocked) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.fail('the real competing transaction must wait for the held source event')
  }
  // Pause a real migration between SQL statements; every lock/update still
  // executes against PostgreSQL, on a separate connection from the writer.
  const pausedBackfill = async (userId: string, coordinator: { botId: string; workspaceId: string }, after: string, allowEarlyDeferral = false) => {
    const tx = await pool.connect()
    const pid = Number((await tx.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
    let entered!: () => void, resume!: () => void
    const reached = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { resume = resolve })
    const originalQuery = tx.query, release = tx.release, query = tx.query.bind(tx)
    tx.query = (async (text: string, values?: unknown[]) => {
      const result = await query(text, values)
      if (text.startsWith(after)) { entered(); await held }
      return result
    }) as PoolClient['query']
    tx.release = () => { tx.query = originalQuery; tx.release = release; release.call(tx) }
    const result = bots.backfillCoordinatorChat({ connect: async () => tx } as Pick<import('pg').Pool, 'connect'>, userId, coordinator)
    // Observe rejections immediately while the assertion waits for a lock.
    const settled = result.then(() => null, error => error as Error)
    if (!allowEarlyDeferral) await Promise.race([reached, result.then(() => { throw new Error('backfill did not reach its pause') })])
    return { pid, resume, settled, reached }
  }

  for (const legacyEvent of [false, true]) await t.test(
    legacyEvent ? 'a captured legacy event still runs the execution migration' : 'an empty execution family skips its recursive update after every NOWAIT read',
    async () => {
      const p = await person(legacyEvent ? 'cost-event' : 'cost-empty')
      const coordinator = await bots.coordinatorBot(p.id, null, { backfill: false })
      const eventId = legacyEvent ? await sourceEvent(p.id) : null
      await pool.query(`INSERT INTO coordinator_messages (id,"userId","botId",position,message) VALUES ($1,$2,NULL,1,'{"role":"user","content":"old chat still moves"}')`, [randomUUID(), p.id])
      await pool.query(`INSERT INTO chat_preferences ("userId","chatKey",muted) VALUES ($1,'coordinator',true)`, [p.id])
      const tx = await pool.connect()
      const statements: string[] = []
      const originalQuery = tx.query, release = tx.release, query = tx.query.bind(tx)
      tx.query = (async (text: string, values?: unknown[]) => {
        statements.push(text)
        return query(text, values)
      }) as PoolClient['query']
      tx.release = () => { tx.query = originalQuery; tx.release = release; release.call(tx) }
      await bots.backfillCoordinatorChat({ connect: async () => tx } as Pick<import('pg').Pool, 'connect'>, p.id, coordinator)
      const lockOrder = ['SELECT i.id FROM issues', 'SELECT id FROM factory_tasks', 'SELECT id FROM coordinator_events', 'SELECT id FROM agent_runs']
        .map(prefix => statements.findIndex(statement => statement.startsWith(prefix)))
      assert.ok(lockOrder.every((index, i) => index >= 0 && (i === 0 || index > lockOrder[i - 1])), 'all original NOWAIT reads run in their original order')
      assert.equal(statements.filter(statement => statement.startsWith('WITH RECURSIVE')).length, legacyEvent ? 1 : 0)
      assert.deepEqual((await messageRows(p.id)).rows.map(row => [row.botId, row.text]), [[coordinator.botId, 'old chat still moves']])
      assert.deepEqual((await pool.query('SELECT "chatKey",muted FROM chat_preferences WHERE "userId"=$1', [p.id])).rows, [{ chatKey: coordinator.botId, muted: true }])
      if (eventId) assert.deepEqual((await pool.query('SELECT "botId" FROM coordinator_events WHERE id=$1', [eventId])).rows, [{ botId: coordinator.botId }])
    },
  )

  await t.test('stale attention reads only settlement fields and preserves the decision input and owner log', async st => {
    const p = await person('cost-attention')
    const now = new Date('2030-01-02T12:00:00.000Z')
    const earlier = new Date(now.getTime() - 45 * 60_000)
    const matterId = randomUUID(), pendingId = randomUUID()
    st.after(() => pool.query('DELETE FROM attention_matters WHERE "userId"=$1', [p.id]))
    for (const id of [matterId, pendingId]) {
      await pool.query(`INSERT INTO attention_matters(id,"userId","matterKey",source,title,level,assessment,evidence,state,reason,"personAsked",recheck,handoffs,"handedAt","updatedAt")
        VALUES($1::uuid,$2,$1::text,'github','Renew the domain','high',$3,$3,'handed','deadline approaching',true,true,1,$4,$4)`,
      [id, p.id, { unusedLargeSource: 'x'.repeat(30_000) }, earlier])
      await pool.query(`INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload,tier,"deliveredAt")
        VALUES($1,$2,'matter_handoff',$3,'{}','attention',$4)`,
      [randomUUID(), p.id, `matter_handoff:${id}:1`, id === matterId ? earlier : null])
    }
    await pool.query(`INSERT INTO attention_log(id,"userId","matterId",action,spends,"createdAt") VALUES($1,$2,$3,'notify',true,$4)`,
      [randomUUID(), p.id, matterId, new Date(now.getTime() - 5 * 60_000)])
    const { releaseAttention } = await import('../lib/attention/store')
    const { settleInput, settleQuestions } = await import('../lib/attention/interrupt')
    const observed: Array<{ owner: string; purpose: string; input: string; questions: unknown }> = []
    const statements: string[] = []
    const originalQuery = appPool.query, query = appPool.query.bind(appPool)
    appPool.query = (async (text: string, values?: unknown[]) => {
      statements.push(typeof text === 'string' ? text : (text as unknown as { text: string }).text)
      return query(text, values)
    }) as typeof appPool.query
    try {
      assert.equal(await releaseAttention(p.id, now, async (owner, purpose, input, questions) => {
        observed.push({ owner, purpose, input, questions })
        return new Map([['settle', { type: 'choice' as const, name: 'settle', choice: 'quiet' }]])
      }), false)
    } finally { appPool.query = originalQuery }
    assert.deepEqual(observed, [{
      owner: p.id, purpose: 'attention-settle',
      input: settleInput({ id: matterId, title: 'Renew the domain', level: 'high', reason: 'deadline approaching', personAsked: true, recheck: true, minutesWaiting: 45 }, { today: 1, minutesSinceLast: 5 }, now),
      questions: settleQuestions(),
    }])
    const staleRead = statements.filter(statement => statement.includes('from "attention_matters"') && statement.includes('"handedAt"'))
    assert.equal(staleRead.length, 1, 'one real stale-row query')
    const projection = staleRead[0].split(' from ')[0]
    assert.doesNotMatch(projection, /"assessment"|"evidence"/, 'unused large source fields never cross the database boundary')
    assert.match(projection, /"userId"/)
    assert.deepEqual((await pool.query('SELECT state,reason,"updatedAt" FROM attention_matters WHERE id=$1', [matterId])).rows, [{ state: 'quiet', reason: 'no decision recorded', updatedAt: now }])
    assert.deepEqual((await pool.query('SELECT "userId","matterId",action,spends,reason FROM attention_log WHERE "matterId"=$1 AND action=\'quiet\'', [matterId])).rows,
      [{ userId: p.id, matterId, action: 'quiet', spends: false, reason: 'no decision recorded' }])
    assert.equal((await pool.query('SELECT state FROM attention_matters WHERE id=$1', [pendingId])).rows[0].state, 'handed', 'an undelivered handoff is not settled')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM attention_log WHERE "matterId"=$1', [pendingId])).rows[0].n, 0)
  })

  await t.test('existing Coordinator chat, runs and settings move to its bot row once; a second pass changes nothing', async () => {
    const p = await person('backfill')
    const agent = await seedAgent(pool, p.id)
    const issue = await seedIssue(pool, p.id)
    // The Coordinator's chat as PR 1 left it: no bot on any row, 'coordinator' as the key.
    const messages: ModelMessage[] = [{ role: 'user', content: 'Plan the launch' }, { role: 'assistant', content: 'Here is the plan' }, { role: 'user', content: 'And the follow-up' }]
    for (const [index, message] of messages.entries()) {
      await pool.query('INSERT INTO coordinator_messages (id,"userId","botId",position,message) VALUES ($1,$2,NULL,$3,$4)', [randomUUID(), p.id, index + 1, JSON.stringify(message)])
    }
    const legacyTrust = { key: SECRET, scope: JSON.stringify([p.id, null]) }
    const summary = preserveMessageSources('The person is planning a launch', messages.slice(0, 2).map(message => ({ message })), null, legacyTrust)
    await pool.query(`INSERT INTO coordinator_sessions ("userId","botId",memory,summary,"summaryThrough") VALUES ($1,NULL,'- prefers short replies',$2,2)`, [p.id, summary])
    const event = randomUUID()
    await pool.query(`INSERT INTO coordinator_events (id,"userId","botId",kind,"dedupeKey",payload) VALUES ($1,$2,NULL,'user_message',$3,'{"text":"waiting"}')`, [event, p.id, `legacy:${event}`])
    const dispatched = await seedRun(pool, { userId: p.id, agentId: agent, botId: null, issueId: issue, status: 'succeeded' })
    const mcp = await seedRun(pool, { userId: p.id, agentId: agent, botId: null })
    await pool.query(`UPDATE agent_runs SET source='mcp' WHERE id=$1`, [mcp])
    await pool.query(`INSERT INTO bot_model_choices ("ownerId","workspaceId","botKey","bindingId") VALUES ($1,$2,'coordinator',NULL)`, [p.id, p.workspaceId])
    await pool.query(`INSERT INTO chat_preferences ("userId","chatKey",pinned,muted) VALUES ($1,'coordinator',false,true)`, [p.id])
    const schedule = randomUUID()
    const definition = { title: 'Morning brief', timezone: 'UTC', timing: { kind: 'once', at: '2030-01-01T09:00:00Z' }, task: { kind: 'reminder', text: 'x' }, misfire: 'skip', maxLatenessMinutes: 60 }
    await pool.query(`INSERT INTO user_schedules (id,owner_id,workspace_id,bot_id,source_event_id,request_id,definition,request_definition,status,next_at)
      VALUES ($1,$2,NULL,NULL,$3,$4,$5,$5,'active','2030-01-01T09:00:00Z')`, [schedule, p.id, event, randomUUID(), definition])
    await pool.query(`INSERT INTO agent_kit_heads (owner_id,bot_key,bot_id,workspace_id,cli_run_policy,external_write_permissions) VALUES ($1,'coordinator',NULL,NULL,$2,$3)`, [p.id, JSON.stringify({ permissions: { git_push: 'deny' } }), JSON.stringify({ send_slack_message: 'deny' })])

    const coordinator = await bots.coordinatorBot(p.id, null)
    assert.equal(coordinator.workspaceId, p.workspaceId, 'older data has no workspace, so it moves to the personal workspace\'s Coordinator')
    const moved = (await messageRows(p.id)).rows
    assert.deepEqual(moved.map(row => [row.botId, row.position, row.text]), [[coordinator.botId, 1, 'Plan the launch'], [coordinator.botId, 2, 'Here is the plan'], [coordinator.botId, 3, 'And the follow-up']], 'messages keep their order')
    const conversation = await store.loadConversation(p.id, coordinator.botId)
    assert.equal(conversation.memory, '- prefers short replies')
    assert.deepEqual(conversation.messages.map(row => row.position), [3], 'the summary still covers the first two')
    const folded = JSON.parse(promptMessages(conversation.summary, conversation.messages, { key: SECRET, scope: JSON.stringify([p.id, coordinator.botId]) })[0].content as string)
    assert.equal(folded.untrustedData.summary, 'The person is planning a launch', 'the summary is signed again for the bot row, so the next turn keeps it')
    assert.deepEqual((await pool.query('SELECT "botId" FROM coordinator_events WHERE id=$1', [event])).rows, [{ botId: coordinator.botId }])
    assert.deepEqual(await store.wakingChats(p.id), [coordinator.botId])
    const runs = (await pool.query<{ id: string; botId: string | null }>('SELECT id,"botId" FROM agent_runs WHERE "userId"=$1 ORDER BY id', [p.id])).rows
    assert.deepEqual(Object.fromEntries(runs.map(row => [row.id, row.botId])), { [dispatched]: coordinator.botId, [mcp]: coordinator.botId }, 'every bot-less run of the person\'s (an MCP client\'s too) is the bot row\'s')
    assert.deepEqual((await pool.query('SELECT "botKey","bindingId" FROM bot_model_choices WHERE "ownerId"=$1', [p.id])).rows, [{ botKey: coordinator.botId, bindingId: null }])
    assert.deepEqual((await pool.query('SELECT "chatKey",muted FROM chat_preferences WHERE "userId"=$1', [p.id])).rows, [{ chatKey: coordinator.botId, muted: true }])
    assert.deepEqual((await pool.query('SELECT bot_id,workspace_id FROM user_schedules WHERE id=$1', [schedule])).rows, [{ bot_id: coordinator.botId, workspace_id: p.workspaceId }])
    assert.deepEqual((await pool.query('SELECT bot_id,workspace_id,cli_run_policy,external_write_permissions FROM agent_kit_heads WHERE owner_id=$1 AND bot_key=$2', [p.id, coordinator.botId])).rows,
      [{ bot_id: coordinator.botId, workspace_id: p.workspaceId, cli_run_policy: {}, external_write_permissions: {} }], 'the new head carries no policy')
    assert.deepEqual((await pool.query('SELECT cli_run_policy,external_write_permissions FROM workspace_computer_policies WHERE "workspaceId"=$1', [p.workspaceId])).rows,
      [{ cli_run_policy: { permissions: { git_push: 'deny' } }, external_write_permissions: { send_slack_message: 'deny' } }], 'the legacy restrictions are folded into the workspace')

    const snapshot = async () => JSON.stringify(await Promise.all([
      messageRows(p.id).then(result => result.rows),
      pool.query('SELECT "botId",memory,summary,"summaryThrough" FROM coordinator_sessions WHERE "userId"=$1', [p.id]).then(result => result.rows),
      pool.query('SELECT id,"botId" FROM agent_runs WHERE "userId"=$1 ORDER BY id', [p.id]).then(result => result.rows),
      pool.query('SELECT "botKey" FROM bot_model_choices WHERE "ownerId"=$1', [p.id]).then(result => result.rows),
      pool.query('SELECT bot_key FROM agent_kit_heads WHERE owner_id=$1 ORDER BY bot_key', [p.id]).then(result => result.rows),
    ]))
    const once = await snapshot()
    await Promise.all([bots.backfillCoordinatorChat(appPool, p.id, coordinator), bots.backfillCoordinatorChat(appPool, p.id, coordinator)])
    assert.equal(await snapshot(), once, 'two more passes at once change nothing')
    assert.equal(Number((await pool.query('SELECT count(*) FROM coordinator_bots WHERE "ownerId"=$1', [p.id])).rows[0].count), 1, 'one Coordinator row')

    // A row an older instance wrote the old way during a deploy goes after what the bot row already holds.
    await pool.query(`INSERT INTO coordinator_messages (id,"userId","botId",position,message) VALUES ($1,$2,NULL,1,'{"role":"assistant","content":"late reply"}')`, [randomUUID(), p.id])
    await bots.backfillCoordinatorChat(appPool, p.id, coordinator)
    assert.deepEqual((await messageRows(p.id)).rows.map(row => [row.botId, row.position, row.text]).at(-1), [coordinator.botId, 4, 'late reply'])
    assert.equal(Number((await pool.query('SELECT count(*) FROM coordinator_messages WHERE "userId"=$1 AND "botId" IS NULL', [p.id])).rows[0].count), 0)
  })

  await t.test('personal backfill preserves shared and unresolved task events, runs, Factory sources and schedules', async () => {
    const p = await person('backfill-tenants')
    const shared = await seedWorkspace(pool, p.id, [{ userId: p.id, role: 'admin' }])
    const agentId = await seedAgent(pool, p.id)
    const sharedIssue = await seedIssue(pool, p.id, shared.id)
    const personalIssue = await seedIssue(pool, p.id, p.workspaceId)
    const pendingIssue = randomUUID()
    await pool.query(`INSERT INTO issues (id,"userId",scope,"linearSyncPolicy","linearSyncBlocked",title,content,status,priority)
      VALUES ($1,$2,'personal','disabled',true,'Unresolved task','{"type":"doc"}','todo','normal')`, [pendingIssue, p.id])
    const sharedRun = await seedRun(pool, { userId: p.id, agentId, issueId: sharedIssue })
    const personalRun = await seedRun(pool, { userId: p.id, agentId, issueId: personalIssue })
    const event = async (issueId: string | null, runId: string | null) => {
      const id = randomUUID()
      await pool.query(`INSERT INTO coordinator_events (id,"userId","issueId","runId",kind,"dedupeKey",payload)
        VALUES ($1,$2,$3,$4,'user_message',$5,'{}')`, [id, p.id, issueId, runId, `backfill-tenant:${id}`])
      return id
    }
    const sharedTaskEvent = await event(sharedIssue, null)
    const sharedRunEvent = await event(null, sharedRun)
    const pendingEvent = await event(pendingIssue, null)
    const sourceEvent = await event(null, null)
    const personalEvent = await event(personalIssue, personalRun)
    const taskId = randomUUID()
    await pool.query(`WITH task AS (
      INSERT INTO factory_tasks (id,"userId","issueId","sourceEventId","workspaceId",route,stage,status,"attemptId",reason)
      VALUES ($1,$2,$3,$4,$6,'{}','execute','running',$5,'Backfill tenant fixture') RETURNING id)
      INSERT INTO factory_attempts (id,"taskId",stage,status,ordinal,position,reason)
      SELECT $5,id,'execute','running',1,1,'Backfill tenant fixture' FROM task`,
      [taskId, p.id, sharedIssue, sourceEvent, randomUUID(), shared.id])
    const schedules = [randomUUID(), randomUUID()]
    const definition = { title: 'Shared reminder', timezone: 'UTC', timing: { kind: 'once', at: '2030-01-01T09:00:00Z' }, task: { kind: 'reminder', text: 'x' }, misfire: 'skip', maxLatenessMinutes: 60 }
    for (const [index, workspaceId] of [shared.id, null].entries()) {
      await pool.query(`INSERT INTO user_schedules (id,owner_id,workspace_id,source_event_id,request_id,definition,request_definition,status,next_at)
        VALUES ($1,$2,$3,$4,$5,$6,$6,'active','2030-01-01T09:00:00Z')`, [schedules[index], p.id, workspaceId, sourceEvent, randomUUID(), definition])
    }

    const personal = await bots.coordinatorBot(p.id, p.workspaceId, { backfill: false })
    await bots.backfillCoordinatorChat(appPool, p.id, personal)
    const events = (await pool.query('SELECT id,"botId" FROM coordinator_events WHERE "userId"=$1', [p.id])).rows
    assert.deepEqual(Object.fromEntries(events.map(row => [row.id, row.botId])), {
      [sharedTaskEvent]: null, [sharedRunEvent]: null, [pendingEvent]: null, [sourceEvent]: null, [personalEvent]: personal.botId,
    })
    assert.deepEqual((await pool.query('SELECT "workspaceId","botId" FROM agent_runs WHERE id=$1', [sharedRun])).rows,
      [{ workspaceId: shared.id, botId: null }])
    assert.deepEqual((await pool.query('SELECT "workspaceId","botId" FROM factory_tasks WHERE id=$1', [taskId])).rows,
      [{ workspaceId: shared.id, botId: null }])
    for (const [index, workspaceId] of [shared.id, null].entries()) {
      assert.deepEqual((await pool.query('SELECT workspace_id,bot_id FROM user_schedules WHERE id=$1', [schedules[index]])).rows,
        [{ workspace_id: workspaceId, bot_id: null }])
    }
  })

  await t.test('one shared-tenant task retains its complete null-Bot source family, including a Personal sibling', async () => {
    const p = await person('backfill-linked-tenants')
    const shared = await seedWorkspace(pool, p.id, [{ userId: p.id, role: 'admin' }])
    const agentId = await seedAgent(pool, p.id), eventId = await sourceEvent(p.id)
    const family: Array<{ taskId: string; runId: string; workspaceId: string }> = []
    // A historical owner message started tasks in two tenants. Retaining only
    // the shared task would move its Personal sibling away from their source.
    for (const workspaceId of [p.workspaceId, shared.id]) {
      const issueId = await seedIssue(pool, p.id, workspaceId)
      const runId = await seedRun(pool, { userId: p.id, agentId, issueId, workspaceId })
      const taskId = randomUUID(), attemptId = randomUUID()
      await pool.query(`WITH task AS (
        INSERT INTO factory_tasks (id,"userId","issueId","sourceEventId","workspaceId",route,stage,status,"attemptId",reason)
        VALUES ($1,$2,$3,$4,$5,'{}','execute','running',$6,'Linked tenant fixture') RETURNING id)
        INSERT INTO factory_attempts (id,"taskId",stage,status,ordinal,position,"runId",reason)
        SELECT $6,id,'execute','running',1,1,$7,'Linked tenant fixture' FROM task`,
        [taskId, p.id, issueId, eventId, workspaceId, attemptId, runId])
      family.push({ taskId, runId, workspaceId })
    }
    const ordinaryRun = await seedRun(pool, { userId: p.id, agentId, workspaceId: p.workspaceId })
    const coordinator = await bots.coordinatorBot(p.id, p.workspaceId, { backfill: false })
    await bots.backfillCoordinatorChat(appPool, p.id, coordinator)
    await bots.backfillCoordinatorChat(appPool, p.id, coordinator)
    assert.deepEqual((await pool.query('SELECT "botId" FROM coordinator_events WHERE id=$1', [eventId])).rows, [{ botId: null }])
    for (const row of family) {
      assert.deepEqual((await pool.query('SELECT "workspaceId","botId" FROM factory_tasks WHERE id=$1', [row.taskId])).rows,
        [{ workspaceId: row.workspaceId, botId: null }])
      assert.deepEqual((await pool.query('SELECT "workspaceId","botId" FROM agent_runs WHERE id=$1', [row.runId])).rows,
        [{ workspaceId: row.workspaceId, botId: null }])
    }
    assert.deepEqual((await pool.query('SELECT "workspaceId","botId" FROM agent_runs WHERE id=$1', [ordinaryRun])).rows,
      [{ workspaceId: p.workspaceId, botId: coordinator.botId }], 'unrelated Personal history still moves')
  })

  await t.test('a new Coordinator message and a run use the real bot id, stored where they enter', async () => {
    const p = await person('new-message')
    const { recordPersonalSubmission } = await import('../lib/coordinator-submission')
    const { recordCoordinatorEvent } = await import('../lib/coordinator-event-store')
    const { runFinishedEvent } = await import('../lib/coordinator-events')
    const { db } = await import('../lib/db')
    // A message enters the Coordinator chat: the entry point resolves its bot row once.
    const botId = await bots.chatBotId(p.id, null, p.workspaceId)
    await recordPersonalSubmission(db, p.id, 'Hello Coordinator', { botId })
    // A run carries the bot that dispatched it; its end reads that and resolves nothing.
    const agent = await seedAgent(pool, p.id)
    const run = await seedRun(pool, { userId: p.id, agentId: agent, botId, status: 'succeeded' })
    await recordCoordinatorEvent(db, runFinishedEvent({ id: run, userId: p.id, botId, issueId: null, kind: 'implement', status: 'succeeded', stopReason: 'completed' }))
    assert.deepEqual((await pool.query('SELECT DISTINCT "botId" FROM coordinator_events WHERE "userId"=$1', [p.id])).rows, [{ botId }])
    const take = await store.takeInbox(p.id, 'coordinator-turn', botId)
    assert.equal(take.added, 1, 'the run report waits for triage; the message is taken')
    await store.appendMessages(p.id, 'coordinator-turn', [{ role: 'assistant', content: 'Hi' }], null, botId)
    const view = await store.chatView(p.id, 200, botId)
    assert.deepEqual(view.items.map(item => [item.from, item.text]), [['person', 'Hello Coordinator'], ['coordinator', 'Hi']])
    assert.equal(Number((await pool.query('SELECT count(*) FROM coordinator_messages WHERE "userId"=$1 AND "botId" IS NULL', [p.id])).rows[0].count), 0)
  })

  await t.test('a legacy run with no bot finishes for an owner with no workspace; its event is kept, and moved once the Coordinator resolves', async () => {
    const owner = await seedUser(pool, 'legacy-run')
    users.push(owner)
    const { recordCoordinatorEvent } = await import('../lib/coordinator-event-store')
    const { runFinishedEvent } = await import('../lib/coordinator-events')
    const { db } = await import('../lib/db')
    const { executionWorkspace } = await import('../lib/execution-settings')
    await assert.rejects(executionWorkspace(owner, null), { code: 'workspaceAccessDenied' }, 'no workspace to resolve')
    const agent = await seedAgent(pool, owner)
    const run = await seedRun(pool, { userId: owner, agentId: agent, botId: null, status: 'succeeded' })
    // Run end records with the run's own (legacy, null) bot: nothing to resolve, nothing to fail.
    await recordCoordinatorEvent(db, runFinishedEvent({ id: run, userId: owner, botId: null, issueId: null, kind: 'implement', status: 'succeeded', stopReason: 'completed' }))
    assert.deepEqual((await pool.query('SELECT "botId" FROM coordinator_events WHERE "runId"=$1', [run])).rows, [{ botId: null }])
    // Resolving the Coordinator gives the person their personal workspace, as the app does, and moves the legacy rows.
    const coordinator = await bots.coordinatorBot(owner, null)
    assert.equal((await pool.query('SELECT kind FROM mikka_workspaces WHERE id=$1', [coordinator.workspaceId])).rows[0].kind, 'personal')
    assert.deepEqual((await pool.query('SELECT "botId" FROM coordinator_events WHERE "runId"=$1', [run])).rows, [{ botId: coordinator.botId }])
    assert.deepEqual((await pool.query('SELECT "botId" FROM agent_runs WHERE id=$1', [run])).rows, [{ botId: coordinator.botId }])
  })

  await t.test('real null-Bot admission retains frozen identity, Factory family and repository authority after backfill', async () => {
    const beforeEnv = { byos: process.env.MIKKA_BYOS_ENABLED, edition: process.env.MIKKA_EDITION }
    process.env.MIKKA_BYOS_ENABLED = '1'
    process.env.MIKKA_EDITION = 'cloud'
    const { overrideDeploymentSwitch } = await import('../lib/deployment-switches')
    overrideDeploymentSwitch('factoryRouting', true)
    overrideDeploymentSwitch('factoryLifecycle', true)
    const github = githubAppStub()
    try {
      const p = await person('frozen-backfill')
      const repo = 'mikka-ci/coordinator-backfill'
      const account = String(9_800_000 + Math.floor(Math.random() * 100_000))
      github.install(repo, { contents: 'write', pull_requests: 'write' })
      github.allowWriter(repo, account)
      await connectGitHub(github, p.id, account, [repo])
      await pool.query('INSERT INTO repository_settings("userId","remoteKey",push) VALUES($1,$2,$3)', [p.id, normalizeRepository(repo).key,
        JSON.stringify({ approved: true, remote: 'origin', approvedByUserId: p.id, approvedAt: new Date().toISOString() })])
      const deviceId = randomUUID(), agentId = await seedAgent(pool, p.id)
      await pool.query(`INSERT INTO devices(id,"ownerId",name,kind,enabled,"lastSeenAt") VALUES($1,$2,'Synthetic backfill device','local',true,now())`, [deviceId, p.id])
      await pool.query('UPDATE agents SET "deviceId"=$2 WHERE id=$1', [agentId, deviceId])
      await seedAllowedModel(pool, p.id, { workspaceId: p.workspaceId, deviceIds: [deviceId] })
      const issueId = await seedIssue(pool, p.id)
      const eventId = await sourceEvent(p.id, { text: 'Synthetic task; no model or machine is invoked', taskDestination: { kind: 'device', deviceId } })
      const { queueTaskRun } = await import('../lib/factory/queue-local')
      const { queueRun } = await import('../lib/agent-runs')
      const { executionIdentityForRun } = await import('../lib/execution-identity')
      const { acceptedEventStillMatches } = await import('../lib/run-admission-store')
      const queued = await queueTaskRun(p.id, { issueId, agentId, repo, model: ALLOWED_MODEL, requestKey: `frozen:${randomUUID()}` }, null, undefined, eventId)
      const original = (await pool.query('SELECT * FROM agent_runs WHERE id=$1', [queued.runId])).rows[0]
      const identity = await executionIdentityForRun(pool, queued.runId, p.id)
      assert.equal(identity?.botId, null, 'the real queue freezes null; this is not a rewritten Bot fixture')
      assert.equal(original.agentDefinition.repositoryAdmission.requestEventId, eventId)
      assert.equal(await acceptedEventStillMatches(original.agentDefinition.repositoryAdmission, null), true)
      const task = (await pool.query(`SELECT t.* FROM factory_tasks t JOIN factory_attempts a ON a."taskId"=t.id WHERE a."runId"=$1`, [queued.runId])).rows[0]
      // A terminal run can still be continued. Its historical sibling and old
      // request epoch must stay in the task's scope even without an identity.
      await pool.query(`UPDATE agent_runs SET status='succeeded',"startedAt"=now(),"finishedAt"=now() WHERE id=$1`, [queued.runId])
      const sibling = await seedRun(pool, { userId: p.id, agentId, issueId })
      const previousEpoch = await sourceEvent(p.id)
      await pool.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"runId",reason,output)
        VALUES($1,$2,'execute',2,2,'passed',$3,'Synthetic historical attempt',$4)`, [randomUUID(), task.id, sibling, JSON.stringify({ requestEpoch: previousEpoch })])
      // One owner message may start more than one task. Moving only the other
      // task would leave it referring to the retained null-Bot source.
      const sharedIssue = await seedIssue(pool, p.id)
      const shared = (await route(p.id, sharedIssue, eventId)).task
      const sharedRun = await seedRun(pool, { userId: p.id, agentId, issueId: sharedIssue })
      await pool.query('UPDATE factory_attempts SET "runId"=$2 WHERE id=$1', [shared.attemptId, sharedRun])
      const { recordCoordinatorEvent } = await import('../lib/coordinator-event-store')
      const { runFinishedEvent } = await import('../lib/coordinator-events')
      const { db } = await import('../lib/db')
      await recordCoordinatorEvent(db, runFinishedEvent({ id: queued.runId, userId: p.id, botId: null, issueId, kind: 'implement', status: 'succeeded', stopReason: 'completed' }))
      // Plain queueRun has no Factory/source-event link. Its own frozen key
      // alone must be sufficient to retain the null-Bot execution domain.
      const directIssue = await seedIssue(pool, p.id)
      const direct = await queueRun(p.id, { issueId: directIssue, agentId, repo, model: ALLOWED_MODEL, requestKey: `direct:${randomUUID()}` }, null)
      const directIdentity = await executionIdentityForRun(pool, direct.runId, p.id)
      assert.equal(directIdentity?.botId, null)
      assert.equal((await pool.query('SELECT 1 FROM factory_attempts WHERE "runId"=$1', [direct.runId])).rowCount, 0)
      const malformed = await seedRun(pool, { userId: p.id, agentId })
      const malformedSource = await sourceEvent(p.id)
      await pool.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [malformed, JSON.stringify({ executionIdentity: null, repositoryAdmission: { requestEventId: malformedSource } })])
      await assert.rejects(executionIdentityForRun(pool, malformed, p.id), { name: 'ExecutionIdentityError' })

      const legacyIssue = await seedIssue(pool, p.id), legacyEvent = await sourceEvent(p.id)
      const legacyTask = (await route(p.id, legacyIssue, legacyEvent)).task
      const legacyRun = await seedRun(pool, { userId: p.id, agentId, issueId: legacyIssue })
      await pool.query('UPDATE factory_attempts SET "runId"=$2 WHERE id=$1', [legacyTask.attemptId, legacyRun])
      const coordinator = await bots.coordinatorBot(p.id, null, { backfill: false })
      await bots.backfillCoordinatorChat(appPool, p.id, coordinator)
      await bots.backfillCoordinatorChat(appPool, p.id, coordinator)
      assert.deepEqual(await executionIdentityForRun(pool, queued.runId, p.id), identity)
      assert.deepEqual(await executionIdentityForRun(pool, direct.runId, p.id), directIdentity)
      assert.deepEqual((await pool.query('SELECT "agentDefinition" FROM agent_runs WHERE id=$1', [queued.runId])).rows[0].agentDefinition, original.agentDefinition, 'the complete frozen snapshot is untouched')
      assert.equal(await acceptedEventStillMatches(original.agentDefinition.repositoryAdmission, null), true)
      assert.deepEqual((await pool.query('SELECT DISTINCT "botId" FROM agent_runs WHERE id=ANY($1::uuid[])', [[queued.runId, direct.runId, sibling, sharedRun, malformed]])).rows, [{ botId: null }])
      assert.deepEqual((await pool.query('SELECT DISTINCT "botId" FROM coordinator_events WHERE id=ANY($1::uuid[]) OR "runId"=$2', [[eventId, previousEpoch, malformedSource], queued.runId])).rows, [{ botId: null }])
      assert.deepEqual((await pool.query('SELECT id,"botId","sourceEventId" FROM factory_tasks WHERE id=$1', [task.id])).rows, [{ id: task.id, botId: null, sourceEventId: eventId }])
      const reader = await pool.connect()
      try {
        // Match the real Factory GET transaction: authorization still takes
        // the issue's shared scope lock even when task/source reads do not.
        await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
        assert.equal((await factoryStore.readTask(reader, p.id, shared.id)).botId, null)
      } finally { await reader.query('ROLLBACK'); reader.release() }
      await assert.rejects(executionIdentityForRun(pool, malformed, p.id), { name: 'ExecutionIdentityError' })
      for (const [table, id] of [['agent_runs', legacyRun], ['coordinator_events', legacyEvent], ['factory_tasks', legacyTask.id]]) {
        assert.deepEqual((await pool.query(`SELECT "botId" FROM ${table} WHERE id=$1`, [id])).rows, [{ botId: coordinator.botId }], 'unrelated unfrozen history still moves')
      }
      // A completion arriving after backfill stays with the original run too.
      await recordCoordinatorEvent(db, runFinishedEvent({ id: sibling, userId: p.id, botId: null, issueId, kind: 'implement', status: 'succeeded', stopReason: 'completed' }))
      await bots.backfillCoordinatorChat(appPool, p.id, coordinator)
      assert.deepEqual((await pool.query('SELECT "botId" FROM coordinator_events WHERE "runId"=$1', [sibling])).rows, [{ botId: null }])
    } finally {
      github.restore()
      overrideDeploymentSwitch('factoryRouting', undefined)
      overrideDeploymentSwitch('factoryLifecycle', undefined)
      if (beforeEnv.byos === undefined) delete process.env.MIKKA_BYOS_ENABLED; else process.env.MIKKA_BYOS_ENABLED = beforeEnv.byos
      if (beforeEnv.edition === undefined) delete process.env.MIKKA_EDITION; else process.env.MIKKA_EDITION = beforeEnv.edition
    }
  })

  for (const kind of ['computer', 'group'] as const) await t.test(`an unfrozen ${kind} run retains its Factory family and ordinary retry`, async () => {
    const p = await person(`bound-${kind}`), agentId = await seedAgent(pool, p.id)
    const issueId = await seedIssue(pool, p.id), eventId = await sourceEvent(p.id)
    const task = (await route(p.id, issueId, eventId)).task
    const runId = await seedRun(pool, { userId: p.id, agentId, issueId, status: 'failed' })
    await pool.query('UPDATE agent_runs SET "agentDefinition"=$2 WHERE id=$1', [runId, JSON.stringify({ schemaVersion: 1, definitionDigest: 'synthetic-legacy', harness: 'codex' })])
    if (kind === 'computer') {
      const computerBot = await seedBot(pool, p.workspaceId, p.id)
      await pool.query('INSERT INTO computer_run_bindings("runId","ownerId","workspaceId","botId") VALUES($1,$2,$3,$4)', [runId, p.id, p.workspaceId, computerBot])
    } else await pool.query(`UPDATE agent_runs SET kind='group_chat' WHERE id=$1`, [runId])
    await pool.query('UPDATE factory_attempts SET "runId"=$2 WHERE id=$1', [task.attemptId, runId])
    const blocked = await factoryStore.apply(p.id, { taskId: task.id, revision: task.revision }, randomUUID(), {
      action: 'finish', status: 'blocked', reason: 'Synthetic unclaimed startup failure', evidence: [], output: {},
    })
    const previousEpoch = await sourceEvent(p.id), sibling = await seedRun(pool, { userId: p.id, agentId, issueId })
    await pool.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"runId",reason,output)
      VALUES($1,$2,'execute',2,2,'passed',$3,'Synthetic historical attempt',$4)`, [randomUUID(), task.id, sibling, JSON.stringify({ requestEpoch: previousEpoch })])
    const ordinary = await seedRun(pool, { userId: p.id, agentId })
    const { recordCoordinatorEvent } = await import('../lib/coordinator-event-store')
    const { runFinishedEvent } = await import('../lib/coordinator-events')
    const { db } = await import('../lib/db')
    await recordCoordinatorEvent(db, runFinishedEvent({ id: runId, userId: p.id, botId: null, issueId, kind: kind === 'group' ? 'group_chat' : 'implement', status: 'failed', stopReason: 'device_lost' }))
    const coordinator = await bots.coordinatorBot(p.id, null, { backfill: false })
    await bots.backfillCoordinatorChat(appPool, p.id, coordinator)
    await bots.backfillCoordinatorChat(appPool, p.id, coordinator)
    assert.deepEqual((await pool.query('SELECT DISTINCT "botId" FROM agent_runs WHERE id=ANY($1::uuid[])', [[runId, sibling]])).rows, [{ botId: null }])
    assert.deepEqual((await pool.query('SELECT DISTINCT "botId" FROM coordinator_events WHERE id=ANY($1::uuid[]) OR "runId"=$2', [[eventId, previousEpoch], runId])).rows, [{ botId: null }])
    assert.deepEqual((await pool.query('SELECT "botId","sourceEventId" FROM factory_tasks WHERE id=$1', [task.id])).rows, [{ botId: null, sourceEventId: eventId }])
    assert.deepEqual((await pool.query('SELECT "botId" FROM agent_runs WHERE id=$1', [ordinary])).rows, [{ botId: coordinator.botId }])
    const retried = await factoryStore.apply(p.id, { taskId: task.id, revision: blocked.task.revision }, randomUUID(), { action: 'retry', reason: 'Retry the retained original execution domain' })
    assert.equal(retried.task.botId, null)
    assert.equal(retried.task.sourceEventId, eventId)
    assert.equal(retried.task.status, 'pending')
    assert.notEqual(retried.task.attemptId, task.attemptId)
  })

  await t.test('a publication holding its issue cannot deadlock with the backfill run lock', { timeout: 10_000 }, async () => {
    const p = await person('publication-before-backfill'), agentId = await seedAgent(pool, p.id), issueId = await seedIssue(pool, p.id)
    const runId = await seedRun(pool, { userId: p.id, agentId, issueId })
    const coordinator = await bots.coordinatorBot(p.id, null, { backfill: false })
    const writer = await pool.connect()
    let migration: Awaited<ReturnType<typeof pausedBackfill>> | undefined
    let runLock: Promise<Error | null> | undefined
    try {
      await writer.query('BEGIN')
      // Publication/completion lock issue -> run; the real scope trigger also
      // takes an issue SHARE lock when a migration only changes the botId.
      await writer.query('SELECT id FROM issues WHERE id=$1 FOR UPDATE', [issueId])
      migration = await pausedBackfill(p.id, coordinator, 'SELECT id FROM agent_runs', true)
      const first = await Promise.race([migration.reached.then(() => 'run-locked'), migration.settled.then(() => 'deferred')])
      runLock = writer.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE', [runId]).then(() => null, error => error as Error)
      if (first === 'run-locked') await waitBlockedBy(migration.pid)
      migration.resume()
      assert.equal(await runLock, null, 'the issue holder must not become a deadlock victim')
      assert.equal((await migration.settled as Error & { code?: string })?.code, '55P03', 'migration defers instead of waiting behind its run lock')
      await writer.query('COMMIT')
    } finally {
      migration?.resume()
      await migration?.settled
      await runLock
      await writer.query('ROLLBACK')
      writer.release()
    }
    await bots.backfillCoordinatorChat(appPool, p.id, coordinator)
    assert.deepEqual((await pool.query('SELECT "botId" FROM agent_runs WHERE id=$1', [runId])).rows, [{ botId: coordinator.botId }])
  })

  await t.test('migration first holds the issue through its run update; real publication continues after commit', { timeout: 10_000 }, async () => {
    const p = await person('backfill-before-publication'), agentId = await seedAgent(pool, p.id), issueId = await seedIssue(pool, p.id)
    const runId = await seedRun(pool, { userId: p.id, agentId, issueId })
    const coordinator = await bots.coordinatorBot(p.id, null, { backfill: false })
    const migration = await pausedBackfill(p.id, coordinator, 'SELECT i.id FROM issues i')
    const { prepareRunPublication } = await import('../lib/run-publications')
    const publication = prepareRunPublication({ id: runId, userId: p.id, issueId, baseBranch: null }, 'https://github.com/mikka-ci/backfill-lock.git')
    const settled = publication.then(value => ({ value }), error => ({ error }))
    try {
      await waitBlockedBy(migration.pid)
      migration.resume()
      assert.equal(await migration.settled, null)
      const result = await settled
      if ('error' in result) throw result.error
      assert.ok(result.value.pushBranch)
      assert.deepEqual((await pool.query('SELECT "botId" FROM agent_runs WHERE id=$1', [runId])).rows, [{ botId: coordinator.botId }])
    } finally { migration.resume(); await migration.settled; await settled }
  })

  await t.test('a run committed after issue locking retains its family until the next pass', { timeout: 10_000 }, async () => {
    const p = await person('late-issue-run'), agentId = await seedAgent(pool, p.id), issueId = await seedIssue(pool, p.id)
    const oldRun = await seedRun(pool, { userId: p.id, agentId, issueId })
    const coordinator = await bots.coordinatorBot(p.id, null, { backfill: false })
    const migration = await pausedBackfill(p.id, coordinator, 'SELECT i.id FROM issues i')
    let lateRun!: string, lateEvent!: string, lateTask!: string
    try {
      const lateIssue = await seedIssue(pool, p.id)
      lateEvent = await sourceEvent(p.id)
      const task = (await route(p.id, lateIssue, lateEvent)).task
      lateTask = task.id
      lateRun = await seedRun(pool, { userId: p.id, agentId, issueId: lateIssue })
      await pool.query('UPDATE factory_attempts SET "runId"=$2 WHERE id=$1', [task.attemptId, lateRun])
      migration.resume()
      assert.equal(await migration.settled, null)
    } finally { migration.resume(); await migration.settled }
    for (const [table, id] of [['agent_runs', lateRun], ['coordinator_events', lateEvent], ['factory_tasks', lateTask]]) {
      assert.deepEqual((await pool.query(`SELECT "botId" FROM ${table} WHERE id=$1`, [id])).rows, [{ botId: null }])
    }
    assert.deepEqual((await pool.query('SELECT "botId" FROM agent_runs WHERE id=$1', [oldRun])).rows, [{ botId: coordinator.botId }])
    await bots.backfillCoordinatorChat(appPool, p.id, coordinator)
    for (const [table, id] of [['agent_runs', lateRun], ['coordinator_events', lateEvent], ['factory_tasks', lateTask]]) {
      assert.deepEqual((await pool.query(`SELECT "botId" FROM ${table} WHERE id=$1`, [id])).rows, [{ botId: coordinator.botId }])
    }
  })

  await t.test('a revoked shared-workspace member run keeps its tenant without blocking unrelated Personal history', async () => {
    const owner = await person('retired-issue-owner'), actor = await person('retired-issue-teammate')
    const shared = await seedWorkspace(pool, owner.id, [{ userId: owner.id, role: 'admin' }, { userId: actor.id, role: 'member' }])
    const agentId = await seedAgent(pool, actor.id), issueId = await seedIssue(pool, owner.id, shared.id)
    const runId = await seedRun(pool, { userId: actor.id, agentId, issueId, workspaceId: shared.id })
    const { recordCoordinatorEvent } = await import('../lib/coordinator-event-store')
    const { runFinishedEvent } = await import('../lib/coordinator-events')
    const { db } = await import('../lib/db')
    const { requireTaskWorkspace } = await import('../lib/task-workspace')
    await recordCoordinatorEvent(db, runFinishedEvent({ id: runId, userId: actor.id, botId: null, issueId, kind: 'implement', status: 'succeeded', stopReason: 'completed' }))
    await pool.query(`UPDATE issues SET scope='personal' WHERE id=$1`, [issueId])
    assert.deepEqual((await pool.query('SELECT "workspaceId","ownershipState" FROM issues WHERE id=$1', [issueId])).rows,
      [{ workspaceId: shared.id, ownershipState: 'bound' }], 'a provider scope change never transfers the task')
    assert.equal((await requireTaskWorkspace(actor.id, shared.id)).id, shared.id, 'the scope change does not revoke membership')
    await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [shared.id, actor.id])
    await assert.rejects(requireTaskWorkspace(actor.id, shared.id), { code: 'workspaceAccessDenied' })
    const ordinary = await seedRun(pool, { userId: actor.id, agentId, workspaceId: actor.workspaceId })
    const coordinator = await bots.coordinatorBot(actor.id, null, { backfill: false })
    await assert.rejects(pool.query('UPDATE agent_runs SET "botId"=$2 WHERE id=$1', [runId, coordinator.botId]),
      { code: '23514' }, 'the database rejects moving a shared run onto the Personal Coordinator')
    await bots.backfillCoordinatorChat(appPool, actor.id, coordinator)
    assert.deepEqual((await pool.query('SELECT "workspaceId","botId" FROM agent_runs WHERE id=$1', [runId])).rows, [{ workspaceId: shared.id, botId: null }])
    assert.deepEqual((await pool.query('SELECT "botId" FROM coordinator_events WHERE "runId"=$1', [runId])).rows, [{ botId: null }])
    assert.deepEqual((await pool.query('SELECT "botId" FROM agent_runs WHERE id=$1', [ordinary])).rows, [{ botId: coordinator.botId }])
  })

  await t.test('an in-flight null-Bot route defers migration; its unfrozen history moves after commit', { timeout: 10_000 }, async () => {
    const p = await person('route-before-backfill'), issueId = await seedIssue(pool, p.id), eventId = await sourceEvent(p.id)
    const coordinator = await bots.coordinatorBot(p.id, null, { backfill: false })
    await withTaskWorkspace(p.id, p.workspaceId, async () => {
      const writer = await pool.connect()
      try {
        await writer.query('BEGIN')
        const pending = (await route(p.id, issueId, eventId, writer)).task
        await assert.rejects(bots.backfillCoordinatorChat(appPool, p.id, coordinator), { code: '55P03' }, 'NOWAIT defers rather than deadlocking against the producer')
        assert.deepEqual((await pool.query('SELECT "botId" FROM coordinator_events WHERE id=$1', [eventId])).rows, [{ botId: null }])
        await writer.query('COMMIT')
        await bots.backfillCoordinatorChat(appPool, p.id, coordinator)
        assert.deepEqual((await pool.query('SELECT "botId" FROM factory_tasks WHERE id=$1', [pending.id])).rows, [{ botId: coordinator.botId }])
        assert.deepEqual((await pool.query('SELECT "botId" FROM coordinator_events WHERE id=$1', [eventId])).rows, [{ botId: coordinator.botId }])
      } finally { try { await writer.query('ROLLBACK') } finally { writer.release() } }
    })
  })

  await t.test('migration first fences a stale source validation before it can create a null-Bot task', { timeout: 10_000 }, async () => {
    const p = await person('backfill-before-route'), issueId = await seedIssue(pool, p.id), eventId = await sourceEvent(p.id)
    const coordinator = await bots.coordinatorBot(p.id, null, { backfill: false })
    const migration = await pausedBackfill(p.id, coordinator, 'SELECT id FROM coordinator_events')
    const pending = route(p.id, issueId, eventId).then(() => null, error => error as Error & { code: string })
    try {
      await waitBlockedBy(migration.pid)
      migration.resume()
      assert.equal(await migration.settled, null)
      assert.equal((await pending)?.code, 'factorySourceMismatch', 'the FOR SHARE predicate is rechecked after the source is moved')
      assert.equal((await pool.query('SELECT 1 FROM factory_tasks WHERE "userId"=$1', [p.id])).rowCount, 0)
      assert.deepEqual((await pool.query('SELECT "botId" FROM coordinator_events WHERE id=$1', [eventId])).rows, [{ botId: coordinator.botId }])
    } finally { migration.resume(); await migration.settled; await pending }
  })

  await t.test('a task committed between migration lock statements keeps its source until the next pass', { timeout: 10_000 }, async () => {
    const p = await person('late-route'), issueId = await seedIssue(pool, p.id), eventId = await sourceEvent(p.id)
    const coordinator = await bots.coordinatorBot(p.id, null, { backfill: false })
    const migration = await pausedBackfill(p.id, coordinator, 'SELECT id FROM factory_tasks')
    try {
      const late = (await route(p.id, issueId, eventId)).task
      migration.resume()
      assert.equal(await migration.settled, null)
      assert.deepEqual((await pool.query('SELECT "botId" FROM factory_tasks WHERE id=$1', [late.id])).rows, [{ botId: null }])
      assert.deepEqual((await pool.query('SELECT "botId" FROM coordinator_events WHERE id=$1', [eventId])).rows, [{ botId: null }])
      await bots.backfillCoordinatorChat(appPool, p.id, coordinator)
      assert.deepEqual((await pool.query('SELECT "botId" FROM factory_tasks WHERE id=$1', [late.id])).rows, [{ botId: coordinator.botId }])
      assert.deepEqual((await pool.query('SELECT "botId" FROM coordinator_events WHERE id=$1', [eventId])).rows, [{ botId: coordinator.botId }])
    } finally { migration.resume(); await migration.settled }
  })

  await t.test('a completion committed after the event lock keeps its legacy run until both can move', { timeout: 10_000 }, async () => {
    const p = await person('late-completion'), agentId = await seedAgent(pool, p.id)
    const runId = await seedRun(pool, { userId: p.id, agentId })
    const coordinator = await bots.coordinatorBot(p.id, null, { backfill: false })
    const migration = await pausedBackfill(p.id, coordinator, 'SELECT id FROM coordinator_events')
    const { recordCoordinatorEvent } = await import('../lib/coordinator-event-store')
    const { runFinishedEvent } = await import('../lib/coordinator-events')
    const { db } = await import('../lib/db')
    try {
      await recordCoordinatorEvent(db, runFinishedEvent({ id: runId, userId: p.id, botId: null, issueId: null, kind: 'implement', status: 'succeeded', stopReason: 'completed' }))
      migration.resume()
      assert.equal(await migration.settled, null)
      assert.deepEqual((await pool.query('SELECT "botId" FROM agent_runs WHERE id=$1', [runId])).rows, [{ botId: null }])
      assert.deepEqual((await pool.query('SELECT "botId" FROM coordinator_events WHERE "runId"=$1', [runId])).rows, [{ botId: null }])
      await bots.backfillCoordinatorChat(appPool, p.id, coordinator)
      assert.deepEqual((await pool.query('SELECT "botId" FROM agent_runs WHERE id=$1', [runId])).rows, [{ botId: coordinator.botId }])
      assert.deepEqual((await pool.query('SELECT "botId" FROM coordinator_events WHERE "runId"=$1', [runId])).rows, [{ botId: coordinator.botId }])
    } finally { migration.resume(); await migration.settled }
  })

  await t.test('a chat writer holding its session cannot deadlock against the migration chat lock', { timeout: 10_000 }, async () => {
    const p = await person('session-before-chat-lock')
    const coordinator = await bots.coordinatorBot(p.id, null, { backfill: false })
    await pool.query('INSERT INTO coordinator_sessions("userId","botId",memory) VALUES($1,$2,\'\') ON CONFLICT DO NOTHING', [p.id, coordinator.botId])
    const writer = await pool.connect()
    let migration: Awaited<ReturnType<typeof pausedBackfill>> | undefined
    let chatLock: Promise<Error | null> | undefined
    try {
      await writer.query('BEGIN')
      assert.equal((await writer.query('SELECT 1 FROM coordinator_sessions WHERE "userId"=$1 AND "botId"=$2 FOR UPDATE', [p.id, coordinator.botId])).rowCount, 1)
      migration = await pausedBackfill(p.id, coordinator, 'SELECT id FROM agent_runs')
      // The exact session -> chat order used by appendMessages. Migration
      // already owns chat and must not wait in reverse for the session row.
      chatLock = writer.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`bot-chat:${p.id}:${coordinator.botId}`]).then(() => null, error => error as Error)
      await waitBlockedBy(migration.pid)
      migration.resume()
      assert.equal((await migration.settled as Error & { code: string })?.code, '55P03')
      assert.equal(await chatLock, null, 'deferral releases the chat lock without PostgreSQL choosing a deadlock victim')
    } finally {
      migration?.resume()
      await migration?.settled
      await chatLock
      await writer.query('ROLLBACK')
      writer.release()
    }
    await bots.backfillCoordinatorChat(appPool, p.id, coordinator)
  })

  await t.test('model choice goes through the ordinary bot path', async () => {
    const p = await person('model-choice')
    const { ExecutionSettings } = await import('../lib/execution-settings')
    const { HOSTED_CHOICE } = await import('../lib/bot-model-menu-view')
    const { botId, workspaceId } = await bots.coordinatorBot(p.id, null)
    const settings = new ExecutionSettings(appPool)
    await settings.setBotModel({ ownerId: p.id, workspaceId }, botId, HOSTED_CHOICE)
    assert.deepEqual((await pool.query('SELECT "botKey" FROM bot_model_choices WHERE "ownerId"=$1', [p.id])).rows, [{ botKey: botId }], 'saved under the bot row, never \'coordinator\'')
    assert.equal(await settings.botModel({ ownerId: p.id, workspaceId }, botId), HOSTED_CHOICE)
  })

  await t.test('the Coordinator stays outside workspace app policy; an ordinary bot does not', async () => {
    const p = await person('app-policy')
    const { botId, workspaceId } = await bots.coordinatorBot(p.id, null)
    const other = randomUUID()
    await pool.query('INSERT INTO bots (id,"ownerId","workspaceId",name) VALUES ($1,$2,$3,\'Writer\')', [other, p.id, workspaceId])
    await pool.query(`INSERT INTO workspace_app_policies ("workspaceId",app,access,"updatedBy") VALUES ($1,'gmail','deny',$2)`, [workspaceId, p.id])
    const { botMayUseApp } = await import('../lib/app-policy/store')
    try {
      assert.equal(await botMayUseApp(botId, 'gmail'), true)
      assert.equal(await botMayUseApp(other, 'gmail'), false)
    } finally { await pool.query('DELETE FROM workspace_app_policies WHERE "workspaceId"=$1', [workspaceId]) }
  })

  await t.test('the bot list (left column and mobile home) has that workspace\'s own Coordinator once, as the Coordinator', async () => {
    const p = await person('bot-list')
    // A bot the person named "Coordinator" themselves stays an ordinary bot.
    const theirs = await seedBot(pool, p.workspaceId, p.id, 'Coordinator')
    const team = await seedWorkspace(pool, p.id, [{ userId: p.id, role: 'admin' }])
    const teamBot = await seedBot(pool, team.id, p.id, 'Writer')
    const { botId } = await bots.coordinatorBot(p.id, null)
    const here = await bots.listOwnerBots(p.id, p.workspaceId)
    assert.deepEqual(here.map(bot => [bot.id, bot.coordinator]), [[botId, true], [theirs, false]], 'first, once, and marked')
    const there = await bots.listOwnerBots(p.id, team.id)
    // One Coordinator per person per workspace (decision 2026-10-31-2130): the team has its own, a bot of the team.
    const teamCoordinator = (await pool.query('SELECT "botId" FROM coordinator_bots WHERE "ownerId"=$1 AND "workspaceId"=$2', [p.id, team.id])).rows[0]?.botId
    assert.ok(teamCoordinator && teamCoordinator !== botId, 'the team workspace has its own Coordinator')
    assert.deepEqual(there.map(bot => [bot.id, bot.coordinator]), [[teamCoordinator, true], [teamBot, false]], 'the other workspace lists its own Coordinator, never this one')
    assert.equal((await pool.query('SELECT "workspaceId" FROM bots WHERE id=$1', [teamCoordinator])).rows[0].workspaceId, team.id)
    assert.deepEqual((await bots.listOwnerBots(p.id, team.id)).map(bot => bot.id), there.map(bot => bot.id), 'created once')
    // Its chat summary is under the same id, so the list draws one entry from it.
    await pool.query(`INSERT INTO coordinator_messages (id,"userId","botId",position,message) VALUES ($1,$2,$3,1,'{"role":"assistant","content":"Morning"}')`, [randomUUID(), p.id, botId])
    const summaries = await store.botChats(p.id)
    assert.deepEqual(Object.keys(summaries), [botId])
    assert.equal(summaries[botId].line, 'Morning')
  })

  await t.test('one Coordinator per workspace; work with no workspace goes to the personal one, never the oldest', async () => {
    // Invited to a team first: the team workspace is older than their personal one.
    const id = await seedUser(pool, 'per-workspace')
    users.push(id)
    const team = await seedWorkspace(pool, id, [{ userId: id, role: 'admin' }])
    const personal = { id: await seedPersonalWorkspace(pool, id) }
    await pool.query(`UPDATE mikka_workspaces SET "createdAt"=now()+interval '1 minute' WHERE id=$1`, [personal.id])
    await pool.query(`INSERT INTO coordinator_messages (id,"userId","botId",position,message) VALUES ($1,$2,NULL,1,'{"role":"user","content":"older chat"}')`, [randomUUID(), id])

    // The team's is resolved first; the older bot-less chat still moves to the personal Coordinator.
    const inTeam = await bots.coordinatorBot(id, team.id)
    const own = await bots.coordinatorBot(id, null)
    assert.equal(inTeam.workspaceId, team.id)
    assert.equal(own.workspaceId, personal.id, 'no workspace of its own: the personal one, not the oldest')
    assert.notEqual(inTeam.botId, own.botId, 'each workspace has its own Coordinator')
    assert.deepEqual((await bots.coordinatorBot(id, team.id)).botId, inTeam.botId, 'created once')
    assert.deepEqual((await messageRows(id)).rows.map(row => row.botId), [own.botId], 'older chat moves to the personal Coordinator')
    assert.equal(await bots.chatBotId(id, null, team.id), inTeam.botId)
    assert.equal(await bots.chatBotId(id, inTeam.botId, null), inTeam.botId, 'a named bot is used as given')

    // A workspace the person is not an active member of gets no Coordinator of theirs.
    const stranger = await seedWorkspace(pool, id, [])
    await assert.rejects(bots.coordinatorBot(id, stranger.id), { code: 'workspaceAccessDenied' })
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM coordinator_bots WHERE "workspaceId"=$1', [stranger.id])).rows[0].n, 0)

    // An authenticated MCP client pins its workspace; an unscoped call has no authority.
    const mcp = await import('../lib/mcp/actions')
    const { actAs } = await import('../lib/acting-user')
    const { tokenWorkspace } = await import('../lib/tokens/principal')
    await assert.rejects(mcp.remember(id, 'unscoped'), { code: 'workspaceAccessDenied' })
    const asPersonal = <T>(work: () => Promise<T>) => actAs({ id, [tokenWorkspace]: personal.id }, work)
    await asPersonal(() => mcp.remember(id, 'ships on Fridays'))
    const memory = async (botId: string) => (await pool.query('SELECT memory FROM coordinator_sessions WHERE "userId"=$1 AND "botId"=$2', [id, botId])).rows[0]?.memory ?? ''
    assert.match(await memory(own.botId), /ships on Fridays/)
    assert.doesNotMatch(await memory(inTeam.botId), /ships on Fridays/)
    assert.match((await asPersonal(() => mcp.readMemory(id))).memory, /ships on Fridays/)
  })

  await t.test('a leaving member\'s Coordinator is paused with their bots and never transferred', async () => {
    const adminId = await seedUser(pool, 'transfer-admin')
    users.push(adminId)
    const admin = { id: adminId, workspaceId: (await seedWorkspace(pool, adminId, [{ userId: adminId, role: 'admin' }])).id }
    const leaving = await seedUser(pool, 'transfer-leaving')
    users.push(leaving)
    await pool.query(`INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,'member','active')`, [admin.workspaceId, leaving, `${leaving}@example.invalid`])
    const helper = await seedBot(pool, admin.workspaceId, leaving, 'Helper')
    const coordinator = await bots.coordinatorBot(leaving, admin.workspaceId)
    assert.equal(coordinator.workspaceId, admin.workspaceId, 'the team workspace holds their Coordinator there')
    const members = await import('../lib/workspace-admin/members')
    const removed = await members.removeMember(admin.id, admin.workspaceId, leaving, admin.id)
    assert.deepEqual(removed.transferred, { bots: 1 }, 'only their own bot is handed over')
    const rows = Object.fromEntries((await pool.query<{ id: string; ownerId: string; archived: boolean }>('SELECT id,"ownerId","archivedAt" IS NOT NULL AS archived FROM bots WHERE id = ANY($1)', [[helper, coordinator.botId]])).rows.map(row => [row.id, row]))
    assert.deepEqual([rows[helper].ownerId, rows[helper].archived], [admin.id, false])
    assert.deepEqual([rows[coordinator.botId].ownerId, rows[coordinator.botId].archived], [leaving, true], 'their Coordinator stays theirs, paused')
    assert.deepEqual(await members.takeOverBot(admin.id, admin.workspaceId, coordinator.botId), { bots: 0 }, 'an admin cannot take it over')
    assert.equal((await pool.query('SELECT "ownerId" FROM bots WHERE id=$1', [coordinator.botId])).rows[0].ownerId, leaving)
  })
})
