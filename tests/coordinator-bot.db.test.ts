// The Coordinator is an ordinary bot row (lib/coordinator/coordinator-bot.ts).
// Real PostgreSQL: its older chat (stored with no bot) moves onto that row
// once, safely twice, and everything new is keyed by the row's id.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import type { ModelMessage } from 'ai'
import { dbUrl, seedAgent, seedBot, seedIssue, seedRun, seedUser, seedWorkspace } from './support/workspace-admin-db'

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
    const workspace = await seedWorkspace(pool, id, [{ userId: id, role: 'admin' }])
    // Their own workspace: the personal one, where work with no workspace of its own goes.
    await pool.query(`UPDATE mikka_workspaces SET kind='personal' WHERE id=$1`, [workspace.id])
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
    const personal = await seedWorkspace(pool, id, [{ userId: id, role: 'admin' }])
    await pool.query(`UPDATE mikka_workspaces SET kind='personal', "createdAt"=now()+interval '1 minute' WHERE id=$1`, [personal.id])
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

    // An MCP client names no workspace: its notes are the personal Coordinator's, not the team's.
    const mcp = await import('../lib/mcp/actions')
    await mcp.remember(id, 'ships on Fridays')
    const memory = async (botId: string) => (await pool.query('SELECT memory FROM coordinator_sessions WHERE "userId"=$1 AND "botId"=$2', [id, botId])).rows[0]?.memory ?? ''
    assert.match(await memory(own.botId), /ships on Fridays/)
    assert.doesNotMatch(await memory(inTeam.botId), /ships on Fridays/)
    assert.match((await mcp.readMemory(id)).memory, /ships on Fridays/)
  })

  await t.test('a leaving member\'s Coordinator is paused with their bots and never transferred', async () => {
    const admin = await person('transfer-admin')
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
