// The Coordinator is an ordinary bot row (lib/coordinator/coordinator-bot.ts).
// Real PostgreSQL: its older chat (stored with no bot) moves onto that row
// once, safely twice, and everything new is keyed by the row's id.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { ModelMessage } from 'ai'
import { dbUrl, seedAgent, seedIssue, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db'

const SECRET = 'isolated-ci-coordinator-backfill-fixture-key-0000'

test('the Coordinator is an ordinary bot row', { skip: !dbUrl }, async t => {
  const previousSecret = process.env.BETTER_AUTH_SECRET
  process.env.BETTER_AUTH_SECRET = SECRET
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: dbUrl, max: 4 })
  const { pool: appPool } = await import('../lib/db')
  const { workspacePool } = await import('../lib/workspace-db')
  const bots = await import('../lib/coordinator/coordinator-bot')
  const store = await import('../lib/coordinator/store')
  const { preserveMessageSources } = await import('../lib/coordinator/message-safety')
  const { promptMessages } = await import('../lib/coordinator/context')
  const users: string[] = []
  t.after(async () => {
    if (previousSecret === undefined) delete process.env.BETTER_AUTH_SECRET
    else process.env.BETTER_AUTH_SECRET = previousSecret
    for (const statement of [
      'DELETE FROM coordinator_messages WHERE "userId" = ANY($1)', 'DELETE FROM coordinator_sessions WHERE "userId" = ANY($1)',
      'DELETE FROM coordinator_events WHERE "userId" = ANY($1)', 'DELETE FROM agent_runs WHERE "userId" = ANY($1)',
      'DELETE FROM agents WHERE "userId" = ANY($1)', 'DELETE FROM issues WHERE "userId" = ANY($1)',
      'DELETE FROM bot_model_choices WHERE "ownerId" = ANY($1)', 'DELETE FROM chat_preferences WHERE "userId" = ANY($1)',
      'DELETE FROM user_schedules WHERE owner_id = ANY($1)', 'DELETE FROM agent_kit_heads WHERE owner_id = ANY($1)',
      'DELETE FROM coordinator_bots WHERE "ownerId" = ANY($1)', 'DELETE FROM bots WHERE "ownerId" = ANY($1)',
      'DELETE FROM mikka_workspace_members WHERE "userId" = ANY($1)', 'DELETE FROM mikka_workspaces WHERE "userId" = ANY($1)',
      'DELETE FROM "user" WHERE id = ANY($1)',
    ]) await pool.query(statement, [users])
    await Promise.all([pool.end(), appPool.end(), workspacePool.end()])
  })
  const person = async (label: string) => {
    const id = await seedUser(pool, label)
    users.push(id)
    const workspace = await seedWorkspace(pool, id, [{ userId: id, role: 'admin' }])
    return { id, workspaceId: workspace.id }
  }
  const messageRows = (userId: string) => pool.query<{ botId: string | null; position: number; text: string }>(
    `SELECT "botId",position,message->>'content' AS text FROM coordinator_messages WHERE "userId"=$1 ORDER BY "botId" NULLS FIRST,position`, [userId])

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
    await pool.query(`INSERT INTO agent_kit_heads (owner_id,bot_key,bot_id,workspace_id,cli_run_policy) VALUES ($1,'coordinator',NULL,NULL,$2)`, [p.id, JSON.stringify({ permissions: { git_push: 'deny' } })])

    const coordinator = await bots.coordinatorBot(p.id)
    assert.equal(coordinator.workspaceId, p.workspaceId, 'the row lives where work with no bot runs (executionWorkspace)')
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
    assert.deepEqual(Object.fromEntries(runs.map(row => [row.id, row.botId])), { [dispatched]: coordinator.botId, [mcp]: null }, 'its threads are the bot row\'s; an MCP client\'s run stays its own')
    assert.deepEqual((await pool.query('SELECT "botKey","bindingId" FROM bot_model_choices WHERE "ownerId"=$1', [p.id])).rows, [{ botKey: coordinator.botId, bindingId: null }])
    assert.deepEqual((await pool.query('SELECT "chatKey",muted FROM chat_preferences WHERE "userId"=$1', [p.id])).rows, [{ chatKey: coordinator.botId, muted: true }])
    assert.deepEqual((await pool.query('SELECT bot_id,workspace_id FROM user_schedules WHERE id=$1', [schedule])).rows, [{ bot_id: coordinator.botId, workspace_id: p.workspaceId }])
    assert.deepEqual((await pool.query('SELECT bot_id,workspace_id,cli_run_policy FROM agent_kit_heads WHERE owner_id=$1 AND bot_key=$2', [p.id, coordinator.botId])).rows,
      [{ bot_id: coordinator.botId, workspace_id: p.workspaceId, cli_run_policy: { permissions: { git_push: 'deny' } } }], 'its run policies come with it')

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

  await t.test('a new Coordinator message and a run with no bot of its own use the real bot id', async () => {
    const p = await person('new-message')
    const { recordPersonalSubmission } = await import('../lib/coordinator-submission')
    const { recordCoordinatorEvent } = await import('../lib/coordinator-event-store')
    const { db } = await import('../lib/db')
    const { botId } = await bots.coordinatorBot(p.id)
    await recordPersonalSubmission(db, p.id, 'Hello Coordinator')
    await recordCoordinatorEvent(db, { userId: p.id, kind: 'run_report', dedupeKey: `report:${randomUUID()}`, issueId: null, runId: null, payload: { text: 'a run with no bot finished' } })
    assert.deepEqual((await pool.query('SELECT DISTINCT "botId" FROM coordinator_events WHERE "userId"=$1', [p.id])).rows, [{ botId }])
    const take = await store.takeInbox(p.id, 'coordinator-turn', botId)
    assert.equal(take.added, 1, 'the run report waits for triage; the message is taken')
    await store.appendMessages(p.id, 'coordinator-turn', [{ role: 'assistant', content: 'Hi' }], null, botId)
    const view = await store.chatView(p.id, 200, botId)
    assert.deepEqual(view.items.map(item => [item.from, item.text]), [['person', 'Hello Coordinator'], ['coordinator', 'Hi']])
    assert.equal(Number((await pool.query('SELECT count(*) FROM coordinator_messages WHERE "userId"=$1 AND "botId" IS NULL', [p.id])).rows[0].count), 0)
  })

  await t.test('model choice goes through the ordinary bot path', async () => {
    const p = await person('model-choice')
    const { ExecutionSettings } = await import('../lib/execution-settings')
    const { HOSTED_CHOICE } = await import('../lib/bot-model-menu-view')
    const { botId, workspaceId } = await bots.coordinatorBot(p.id)
    const settings = new ExecutionSettings(appPool)
    await settings.setBotModel({ ownerId: p.id, workspaceId }, botId, HOSTED_CHOICE)
    assert.deepEqual((await pool.query('SELECT "botKey" FROM bot_model_choices WHERE "ownerId"=$1', [p.id])).rows, [{ botKey: botId }], 'saved under the bot row, never \'coordinator\'')
    assert.equal(await settings.botModel({ ownerId: p.id, workspaceId }, botId), HOSTED_CHOICE)
  })

  await t.test('the Coordinator stays outside workspace app policy; an ordinary bot does not', async () => {
    const p = await person('app-policy')
    const { botId, workspaceId } = await bots.coordinatorBot(p.id)
    const other = randomUUID()
    await pool.query('INSERT INTO bots (id,"ownerId","workspaceId",name) VALUES ($1,$2,$3,\'Writer\')', [other, p.id, workspaceId])
    await pool.query(`INSERT INTO workspace_app_policies ("workspaceId",app,access,"updatedBy") VALUES ($1,'gmail','deny',$2)`, [workspaceId, p.id])
    const { botMayUseApp } = await import('../lib/app-policy/store')
    try {
      assert.equal(await botMayUseApp(botId, 'gmail'), true)
      assert.equal(await botMayUseApp(other, 'gmail'), false)
    } finally { await pool.query('DELETE FROM workspace_app_policies WHERE "workspaceId"=$1', [workspaceId]) }
  })
})
