import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { Pool } from 'pg'
import { isE2eTarget } from '../../tests/helpers/e2e-target.mjs'
import { taskStateOf } from '../task-state'
import { InboxStore } from './store'
import { createInboxGuard } from './workspace'
import { handleInbox } from './http'
import { tokenWorkspace } from '../tokens/principal'
import { ActionFailureError } from '../action-error'

const target = process.env.E2E_DATABASE_URL
const valid = isE2eTarget(target) && target === process.env.MIKKA_DATABASE_URL && target === process.env.DATABASE_URL
if (process.env.REQUIRE_DB === '1' && !valid) throw new Error('Inbox tests require matching isolated loopback _e2e URLs')

test('inbox PostgreSQL: workspace authority, receipts, undo and durable deadlines', { skip: !valid }, async t => {
  const admin = new Pool({ connectionString: target, max: 1 })
  const schema = `inbox_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA ${schema}`)
  const pool = new Pool({ connectionString: target, options: `-c search_path=${schema}`, max: 6 })
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end() })
  // Actual migrated source columns, defaults and constraints. LIKE deliberately
  // omits foreign keys to public so every fixture stays in our private schema.
  for (const table of ['"user"', 'issues', 'agent_runs', 'bots', 'suggestions', 'run_messages', 'factory_tasks', 'factory_attempts', 'factory_questions', 'factory_approvals', 'factory_merges', 'attention_matters', 'coordinator_events', 'mikka_workspaces', 'mikka_workspace_members', 'mikka_teams', 'mikka_team_issues', 'resource_access_policies', 'resource_access_grants', 'run_publications', 'agent_tool_approvals', 'local_computer_reviews', 'factory_candidates', 'factory_deliverable_acceptances']) {
    await pool.query(`CREATE TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES)`)
  }
  // Exercise the function installed by the real ACL migrations against this
  // schema's isolated policy and grant rows, including inherited restrictions.
  const acl = await admin.query<{ definition: string }>(`
    SELECT pg_get_functiondef('public.mikka_resource_acl_allowed(text,text,uuid,text,uuid,text)'::regprocedure) AS definition`)
  await pool.query(acl.rows[0].definition.replace('public.mikka_resource_acl_allowed', 'mikka_resource_acl_allowed'))
  await pool.query('ALTER TABLE suggestions DROP COLUMN "rejectedAt", DROP COLUMN "rejectedBy"')
  await pool.query(await readFile(new URL('../../drizzle/20261109130000_inbox.sql', import.meta.url), 'utf8'))
  const owner = 'inbox-owner', peer = 'inbox-peer', stranger = 'inbox-stranger'
  const personal = randomUUID(), workspace = randomUUID(), other = randomUUID(), team = randomUUID(), otherTeam = randomUUID(), bot = randomUUID(), teamBot = randomUUID()
  for (const user of [owner, peer, stranger]) await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())', [user, `${user}@example.invalid`])
  for (const [id, kind] of [[personal, 'personal'], [workspace, 'team'], [other, 'team']]) await pool.query('INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES($1::uuid,$2,$1::text,$3)', [id, owner, kind])
  for (const [id, user] of [[personal, owner], [workspace, owner], [workspace, peer], [other, owner]]) await pool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES($1,$2,$2,$2,\'member\')', [id, user])
  for (const [id, ws] of [[team, workspace], [otherTeam, other]]) await pool.query('INSERT INTO mikka_teams(id,"workspaceId","userId",name,identifier) VALUES($1::uuid,$2,$3,$1::text,\'INBOX\')', [id, ws, owner])
  for (const [id, ws] of [[bot, personal], [teamBot, workspace]]) await pool.query('INSERT INTO bots(id,"workspaceId","ownerId",name) VALUES($1::uuid,$2,$3,$1::text)', [id, ws, owner])
  const issue = randomUUID(), privateIssue = randomUUID(), foreignIssue = randomUUID(), run = randomUUID()
  for (const [id, ws] of [[issue, workspace], [foreignIssue, other], [privateIssue, personal]]) await pool.query('INSERT INTO issues(id,"userId",title,content,status,priority,scope,number,"workspaceId","ownershipState") VALUES($1::uuid,$2,$1::text,\'{"attrs":{"mikka":{}}}\',\'todo\',\'normal\',\'personal\',$3,$4,\'bound\')', [id, owner, ([issue, foreignIssue, privateIssue] as string[]).indexOf(id) + 1, ws])
  await pool.query(`INSERT INTO resource_access_policies(kind,id,"workspaceId","ownerId",visibility,provenance)
    SELECT 'task',id,"workspaceId","userId",'private','created' FROM issues`)
  await pool.query(`INSERT INTO resource_access_grants("resourceKind","resourceId","subjectKind","subjectId",capabilities)
    VALUES('task',$1,'account',$2,ARRAY['canReadContent'])`, [issue, peer])
  for (const [id, ws, tm] of [[issue, workspace, team], [foreignIssue, other, otherTeam]]) await pool.query('INSERT INTO mikka_team_issues("issueId","workspaceId","teamId",number,"userId") VALUES($1,$2,$3,1,$4)', [id, ws, tm, owner])
  for (const [id, task] of [[run, issue], [randomUUID(), privateIssue], [randomUUID(), foreignIssue]]) await pool.query('INSERT INTO agent_runs(id,"userId","issueId","agentId","workspaceId",status,outcome) VALUES($1,$2,$3,$4,(SELECT "workspaceId" FROM issues WHERE id=$3),\'waiting_input\',\'needs_input\')', [id, owner, task, randomUUID()])
  const suggestion = randomUUID(), teamSuggestion = randomUUID()
  for (const [id, botId] of [[suggestion, bot], [teamSuggestion, teamBot]]) await pool.query('INSERT INTO suggestions(id,"userId","botId",source,"externalId",action,title,shown,"decidedBy","occurredAt") VALUES($1::uuid,$2,$3,\'gmail\',$1::text,\'reply\',$1::text,true,\'rule\',now())', [id, owner, botId])
  let now = new Date()
  const pushes: [string, string][] = [], arms: number[] = []
  // The source/store suite keeps every fixture in its private schema. Exercise
  // the admission adapter with the same locked membership facts; the canonical
  // task-workspace DB suites own its session/Enterprise policy implementation.
  const admit: Parameters<typeof createInboxGuard>[0] = async (reader, workspaceId, work) => {
    const userId = typeof reader === 'string' ? reader : reader.id, tx = await pool.connect()
    try {
      await tx.query('BEGIN')
      const { rows: [selected] } = await tx.query<{ kind: 'personal' | 'team'; userId: string }>('SELECT kind,"userId" FROM mikka_workspaces WHERE id=$1 FOR SHARE', [workspaceId])
      if (!selected || (selected.kind === 'personal' && selected.userId !== userId)) throw new ActionFailureError('workspaceAccessDenied')
      const member = await tx.query('SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 AND status=\'active\' FOR SHARE', [workspaceId, userId])
      if (!member.rowCount) throw new ActionFailureError('workspaceAccessDenied')
      const result = await work({ id: workspaceId, kind: selected.kind }, undefined as never)
      await tx.query('COMMIT')
      return result
    } catch (error) { await tx.query('ROLLBACK'); throw error } finally { tx.release() }
  }
  const store = new InboxStore(pool, createInboxGuard(admit), async (user, ws) => { pushes.push([user, ws]) }, async () => { arms.push(1) }, () => now)
  const list = (user = owner, ws = workspace, tab: 'pending' | 'done' | 'snoozed' = 'pending', limit = 50, cursor?: string) => store.list(user, ws, tab, limit, cursor)
  const reject = (id = teamSuggestion, ws = workspace, user = owner) => store.command(user, { workspaceId: ws, type: 'suggestion', id, action: 'reject' })

  await t.test('production admission uses canonical locked membership and rejects a removed or foreign personal member', async () => {
    const canonicalOwner = `inbox-canonical-${randomUUID()}`, canonicalPeer = `inbox-peer-${randomUUID()}`, id = randomUUID()
    const guard = createInboxGuard()
    try {
      for (const user of [canonicalOwner, canonicalPeer]) await admin.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())', [user, `${user}@example.invalid`])
      await admin.query('INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES($1,$2,\'fixture\',\'personal\')', [id, canonicalOwner])
      await admin.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES($1,$2,$2,$2,\'member\')', [id, canonicalOwner])
      // Migrated public tables reject new corrupt memberships. The private
      // schema below still exercises reads of historical corrupt rows.
      await assert.rejects(admin.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES($1,$2,$2,$2,\'member\')', [id, canonicalPeer]), { code: '23514' })
      assert.equal((await admin.query('SELECT 1 FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [id, canonicalPeer])).rowCount, 0)
      assert.equal(await guard({ id: canonicalOwner }, id, async scope => scope.personal), true)
      await assert.rejects(guard({ id: canonicalPeer }, id, async () => assert.fail('foreign personal admission')), { code: 'workspaceAccessDenied' })
      await admin.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [id, canonicalOwner])
      await assert.rejects(guard({ id: canonicalOwner }, id, async () => assert.fail('removed member admission')), { code: 'workspaceAccessDenied' })
    } finally {
      await admin.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1', [id])
      await admin.query('DELETE FROM mikka_workspaces WHERE id=$1', [id])
      await admin.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[canonicalOwner, canonicalPeer]])
      await (await import('../workspace-db')).workspacePool.end()
    }
  })
  await t.test('active workspace isolation and task-specific reply authority', async () => {
    assert.deepEqual(new Set((await list(owner, personal)).items.map(i => i.id)), new Set([privateIssue, suggestion]))
    const mine = await list()
    assert.deepEqual(new Set(mine.items.map(i => i.id)), new Set([issue, teamSuggestion]))
    const shared = await list(peer)
    assert.deepEqual(shared.items.map(i => i.id), [issue])
    assert.ok(!shared.items[0].actions.includes('reply'))
    assert.ok(mine.items.find(i => i.id === issue)!.actions.includes('reply'))
    await assert.rejects(list(stranger), { code: 'workspaceAccessDenied' })
    await assert.rejects(reject(suggestion), { code: 'inboxNotFound' })
    await assert.rejects(reject(teamSuggestion, other), { code: 'inboxNotFound' })
    await assert.rejects(reject(teamSuggestion, workspace, peer), { code: 'inboxNotFound' })
  })
  await t.test('owner approvals outrank an active run; expiration and blocking match the Task state', async () => {
    const approval = randomUUID()
    await pool.query("UPDATE agent_runs SET status='running',outcome=NULL WHERE id=$1", [run])
    await pool.query(`INSERT INTO agent_tool_approvals(id,"runId","userId","deviceId","requestId",harness,method,input,digest,status,"expiresAt")
      VALUES($1,$2,$3,$4,'inbox-review','codex','fixture','{}','digest','pending',now()+interval '1 hour')`, [approval, run, owner, randomUUID()])
    const ownerRow = async () => (await list()).items.find(item => item.id === issue)
    const before = taskStateOf({ status:'todo',metadata:{pullRequests:[]} }, {runId:run,status:'running',outcome:null,awaitingApproval:true})
    assert.deepEqual([before.state,before.reason], ['waiting','approval'])
    assert.equal((await ownerRow())?.reason, 'confirm')
    assert.ok(!(await list(peer)).items.some(item => item.id === issue), 'a private tool prompt cannot create a teammate action')
    await pool.query(`UPDATE agent_runs SET "failureDetails"=$2 WHERE id=$1`, [run, {
      schemaVersion:1, runId:run, code:'run_failed', category:'subscription', occurredAt:'2026-11-08T00:00:00Z', appVersion:'fixture',
    }])
    assert.equal(await ownerRow(), undefined)
    await pool.query('UPDATE agent_runs SET "failureDetails"=NULL WHERE id=$1', [run])
    await pool.query('UPDATE agent_tool_approvals SET "expiresAt"=now() WHERE id=$1', [approval])
    assert.equal(await ownerRow(), undefined)
    await pool.query("UPDATE agent_runs SET status='waiting_input',outcome='needs_input' WHERE id=$1", [run])
  })
  await t.test('canonical ownership ignores missing and stale team links and denies unresolved tasks and corrupt personal members', async () => {
    await pool.query('DELETE FROM mikka_team_issues WHERE "issueId"=$1', [issue])
    assert.ok((await list(peer)).items.some(i => i.id === issue), 'team-less canonical tasks remain visible')
    await pool.query('UPDATE mikka_team_issues SET "workspaceId"=$2,"teamId"=$3 WHERE "issueId"=$1', [foreignIssue, workspace, team])
    assert.ok(!(await list()).items.some(i => i.id === foreignIssue), 'a stale link cannot cross tenants')
    await pool.query('UPDATE issues SET "workspaceId"=NULL,"ownershipState"=\'pending\' WHERE id=$1', [issue])
    assert.ok(!(await list()).items.some(i => i.id === issue))
    await assert.rejects(store.command(owner, { workspaceId: workspace, type: 'task', id: issue, action: 'reopen' }), { code: 'inboxNotFound' })
    await pool.query('UPDATE issues SET "workspaceId"=$2,"ownershipState"=\'bound\' WHERE id=$1', [issue, workspace])
    await pool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role) VALUES($1,$2,$2,$2,\'member\')', [personal, peer])
    await assert.rejects(list(peer, personal), { code: 'workspaceAccessDenied' })
  })
  await t.test('threadless manual and PR reviews retain canonical state, cursor, snooze and resource access', async () => {
    const review = randomUUID(), project = randomUUID()
    await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority,scope,number,"workspaceId","ownershipState")
      VALUES($1,$2,'Review without a run','{"attrs":{"mikka":{}}}','review','normal','workspace',91,$3,'bound')`, [review, owner, workspace])
    await pool.query(`INSERT INTO resource_access_policies(kind,id,"workspaceId","ownerId",visibility,provenance,"parentKind","parentId")
      VALUES('project',$1,$3,$4,'private','created',NULL,NULL),('task',$2,$3,$4,'shared','created','project',$1)`, [project, review, workspace, owner])
    const ids = async (user: string, tab: 'pending' | 'snoozed' | 'done' = 'pending') => {
      const entries = []
      let cursor: string | undefined
      do {
        const page = await list(user, workspace, tab, 1, cursor)
        entries.push(...page.items)
        cursor = page.nextCursor ?? undefined
      } while (cursor)
      return entries
    }
    const includes = async (user: string, tab: 'pending' | 'snoozed' | 'done' = 'pending') =>
      (await ids(user, tab)).some(item => item.id === review)
    const ownerCount = await store.pendingCount(owner, workspace)
    for (const [status, states] of [['review', []], ['todo', ['merged','draft']], ['todo', ['open']], ['todo', ['merged']], ['done', ['open']]] as const) {
      const pullRequests = states.map(state => ({ state, url: 'https://github.com/example/example/pull/1' }))
      await pool.query('UPDATE issues SET status=$2,content=$3 WHERE id=$1', [review, status, {attrs:{mikka:{pullRequests}}}])
      const waiting = taskStateOf({ status, metadata: { pullRequests } }).state === 'waiting'
      const row = (await ids(owner)).find(item => item.id === review)
      assert.equal(Boolean(row), waiting)
      assert.equal(await store.pendingCount(owner, workspace), ownerCount - Number(!waiting))
      if (row) {
        assert.equal(row.reason, 'review')
        assert.equal(row.runId, null)
        assert.deepEqual(row.actions, ['open','snooze'])
      }
    }
    await pool.query("UPDATE issues SET status='review' WHERE id=$1", [review])
    const count = await store.pendingCount(peer, workspace)
    assert.equal(await includes(peer), false)
    await pool.query(`INSERT INTO resource_access_grants("resourceKind","resourceId","subjectKind","subjectId",capabilities)
      VALUES('project',$1,'account',$2,ARRAY['canReadContent'])`, [project,peer])
    assert.equal(await includes(peer), true)
    assert.equal(await store.pendingCount(peer, workspace), count + 1)
    const until = new Date(now.getTime() + 60_000).toISOString()
    assert.equal((await store.command(peer, {workspaceId: workspace, type:'task', id:review, action:'snooze', until})).changed, true)
    assert.equal(await includes(peer, 'snoozed'), true)
    assert.equal(await includes(owner), true)
    await pool.query(`INSERT INTO inbox_history(id,"itemType","itemId","ownerId","actorId",action,"sourceKey")
      VALUES($1,'task',$2,$3,$3,'approved',$4)`, [randomUUID(), review, owner, 'review-' + review])
    assert.equal(await includes(peer, 'done'), true)
    await pool.query(`UPDATE resource_access_grants SET "expiresAt"=now() WHERE "resourceKind"='project' AND "resourceId"=$1`, [project])
    assert.equal(await includes(peer, 'snoozed'), false)
    assert.equal(await includes(peer, 'done'), false)
    await assert.rejects(store.command(peer, {workspaceId: workspace, type:'task', id:review, action:'reopen'}), { code:'inboxNotFound' })
    assert.equal(await includes(owner, 'done'), true)
    await pool.query('DELETE FROM inbox_history WHERE "itemId"=$1', [review])
    await pool.query('DELETE FROM inbox_snoozes WHERE "itemId"=$1', [review])
    await pool.query('DELETE FROM issues WHERE id=$1', [review])
    pushes.length = 0
    arms.length = 0
  })
  await t.test('concurrent rejection is idempotent, attributed and undoable', async () => {
    const matter = randomUUID(), event = randomUUID()
    await pool.query(`INSERT INTO attention_matters(id,"userId","matterKey",source,"suggestionId",title,level,assessment,evidence,state)
      VALUES($1,$2,'inbox-test','gmail',$3,'fixture','ask','{}','{}','handed')`, [matter, owner, teamSuggestion])
    await pool.query(`INSERT INTO coordinator_events(id,"userId",kind,"dedupeKey",payload,tier)
      VALUES($1::uuid,$2,'matter_handoff',$1::text,jsonb_build_object('matterId',$3::text),'attention')`, [event, owner, matter])
    const results = await Promise.all([reject(), reject()])
    assert.equal((await pool.query('SELECT state FROM attention_matters WHERE id=$1', [matter])).rows[0].state, 'quiet')
    assert.ok((await pool.query('SELECT "deliveredAt" FROM coordinator_events WHERE id=$1', [event])).rows[0].deliveredAt, 'a queued handoff cannot reannounce the rejected suggestion')
    assert.equal(results.filter(r => r.changed).length, 1)
    assert.ok(!(await list()).items.some(i => i.id === teamSuggestion))
    const history = await list(owner, workspace, 'done')
    assert.equal(history.items.length, 1)
    assert.equal(history.items[0].completion!.action, 'rejected')
    assert.equal(history.items[0].completion!.actorId, owner)
    assert.deepEqual(history.items[0].actions, ['undo_reject'])
    assert.equal(pushes.length, 1)
    const undo = { workspaceId: workspace, type: 'suggestion' as const, id: teamSuggestion, action: 'undo_reject' as const }
    assert.equal((await store.command(owner, undo)).changed, true)
    assert.equal((await store.command(owner, undo)).changed, false)
    assert.ok((await list()).items.some(i => i.id === teamSuggestion))
    assert.equal((await list(owner, workspace, 'done')).items.length, 1, 'undo retains the audit receipt')
    assert.equal((await pool.query('SELECT state FROM attention_matters WHERE id=$1', [matter])).rows[0].state, 'waiting')
  })
  await t.test('task and suggestion snooze wake exactly at the persisted due time, with live invalidation and no polling', async () => {
    const due = new Date(now.getTime() + 60_123)
    for (const [type, id] of [['task', issue], ['suggestion', teamSuggestion]] as const) {
      const command = { workspaceId: workspace, type, id, action: 'snooze' as const, until: due.toISOString() }
      assert.equal((await store.command(owner, command)).changed, true)
      assert.equal((await store.command(owner, command)).changed, false)
    }
    assert.equal((await list()).items.length, 0)
    assert.equal((await list(owner, workspace, 'snoozed')).items.length, 2)
    assert.equal(await store.pendingCount(owner, workspace), 0, 'badge excludes both snoozed rows')
    assert.equal(await store.pendingCount(peer, workspace), 1, 'badge respects viewer scope')
    assert.equal((await list(peer)).items.length, 1, 'personal snooze never hides a teammate task')
    assert.equal(await store.nextDue(), due.getTime())
    const before = pushes.length
    now = new Date(due.getTime() - 1)
    assert.equal(await store.expire(), due.getTime())
    assert.equal(pushes.length, before)
    now = due
    assert.equal(await store.expire(), null)
    assert.equal(pushes.length, before + 1)
    assert.deepEqual(pushes.at(-1), [owner, workspace])
    assert.equal((await list()).items.length, 2)
    await store.expire()
    assert.equal(pushes.length, before + 1)
    assert.equal(arms.length, 4)
  })
  await t.test('manual reopen is idempotent; expired or malformed times are rejected', async () => {
    await store.command(owner, { workspaceId: workspace, type: 'task', id: issue, action: 'snooze', until: new Date(now.getTime() + 60_000).toISOString() })
    const reopen = { workspaceId: workspace, type: 'task' as const, id: issue, action: 'reopen' as const }
    assert.equal((await store.command(owner, reopen)).changed, true)
    assert.equal((await store.command(owner, reopen)).changed, false)
    await assert.rejects(store.command(owner, { ...reopen, action: 'snooze', until: now.toISOString() }), { code: 'inboxInvalid' })
  })
  await t.test('accepted suggestion and answered question receipts commit or roll back with the actual write', async () => {
    const tx = await pool.connect()
    try {
      await tx.query('BEGIN')
      await tx.query('UPDATE suggestions SET "dismissedAt"=now() WHERE id=$1', [teamSuggestion])
      assert.equal((await list(owner, workspace, 'done')).items.length, 1)
      await tx.query('ROLLBACK')
    } finally { tx.release() }
    await pool.query('UPDATE suggestions SET "dismissedAt"=now() WHERE id=$1', [teamSuggestion])
    const message = randomUUID()
    await pool.query('INSERT INTO run_messages(id,"runId","userId",text) VALUES($1,$2,$3,\'answer\') ON CONFLICT DO NOTHING', [message, run, owner])
    await pool.query('INSERT INTO run_messages(id,"runId","userId",text) VALUES($1,$2,$3,\'answer\') ON CONFLICT DO NOTHING', [message, run, owner])
    const done = await list(owner, workspace, 'done')
    assert.equal(done.items.length, 3)
    assert.ok(done.items.some(i => i.completion!.action === 'accepted'))
    assert.equal(done.items.filter(i => i.completion!.action === 'answered').length, 1)
    await assert.rejects(reject(), { code: 'inboxConflict' })
    assert.equal((await list(peer, workspace, 'done')).items.length, 1, 'teammates see task receipts, never private suggestions')
  })
  await t.test('Factory human answers, approvals and successful merges create one source-bound receipt', async () => {
    const task = randomUUID(), attempt = randomUUID(), candidate = randomUUID(), question = randomUUID(), answer = randomUUID(), merge = randomUUID()
    const sourceEvent = randomUUID()
    await pool.query(`INSERT INTO coordinator_events(id,"userId","issueId",kind,"dedupeKey",payload,tier)
      VALUES($1,$2,$3,'user_message',$4,'{}','background')`, [sourceEvent, owner, issue, 'inbox-'+sourceEvent])
    await pool.query(`INSERT INTO factory_tasks(id,"userId","issueId","sourceEventId",route,stage,status,"attemptId",reason,"workspaceId")
      VALUES($1,$2,$3,$4,'{}','approval','pending',$5,'fixture',$6)`, [task, owner, issue, sourceEvent, attempt, workspace])
    await pool.query(`INSERT INTO factory_attempts(id,"taskId",stage,ordinal,position,status,"runId",reason)
      VALUES($1,$2,'approval',1,1,'pending',$3,'fixture')`, [attempt, task, run])
    await pool.query(`INSERT INTO factory_questions(id,"userId","issueId","taskId","attemptId",stage,"originRunId","originSessionId","originRevision","waitingBinding",kind,question,request,status,reason,"sourceEventId")
      VALUES($1,$2,$3,$4,$5,'execute',$6,'synthetic',1,'{}','context','fixture','{}','waiting_user','fixture',$7)`, [question, owner, issue, task, attempt, run, randomUUID()])
    await pool.query(`UPDATE factory_tasks SET stage='execute' WHERE id=$1`, [task])
    await pool.query(`UPDATE agent_runs SET status='running' WHERE id=$1`, [run])
    assert.ok((await list(owner, workspace, 'pending')).items.some(item => item.id === issue), 'a waiting Factory question is a snoozable Inbox Task even while its run is active')
    assert.ok(!(await list(peer, workspace, 'pending')).items.some(item => item.id === issue), 'a private question cannot make the Task pending for another member')
    await pool.query(`UPDATE factory_tasks SET stage='approval' WHERE id=$1`, [task])
    await pool.query(`UPDATE factory_questions SET "answerId"=$2,"answerSource"='human',"answeredAt"=now() WHERE id=$1`, [question, answer])
    await pool.query("UPDATE factory_tasks SET stage='spec',status='passed' WHERE id=$1", [task])
    assert.equal((await list()).items.find(item => item.id === issue)?.reason, 'review')
    await pool.query("UPDATE factory_tasks SET status='blocked' WHERE id=$1", [task])
    assert.ok(!(await list()).items.some(item => item.id === issue))
    await pool.query("UPDATE factory_tasks SET stage='approval',status='pending' WHERE id=$1", [task])
    await pool.query("UPDATE coordinator_events SET kind='matter_handoff' WHERE id=$1", [sourceEvent])
    assert.ok(!(await list()).items.some(item => item.id === issue), 'an unverified Factory source cannot create an approval')
    await pool.query("UPDATE coordinator_events SET kind='user_message' WHERE id=$1", [sourceEvent])
    await pool.query(`INSERT INTO run_messages(id,"runId","userId",text) VALUES($1,$2,$3,'answer')`, [answer, run, owner])
    await pool.query(`INSERT INTO factory_approvals(id,"taskId","candidateId","attemptId","userId","eventId",request,candidate,action,target,evidence,"approvedRevision","publishAttemptId","publishRevision","expiresAt","principalId")
      VALUES($1,$2,$3,$4,$5,$6,'{}','{}','deploy_preview','fixture','{}',1,$4,1,now()+interval '1 day','human')`, [randomUUID(), task, candidate, attempt, owner, randomUUID()])
    await pool.query(`INSERT INTO factory_merges(id,"taskId","candidateId","userId","eventId","pullRequestUrl",sha,status,source)
      VALUES($1,$2,$3,$4,$5,'https://github.com/example/example/pull/1','synthetic','merging','mikka')`, [merge, task, candidate, owner, randomUUID()])
    assert.equal((await list(owner, workspace, 'done')).items.length, 5, 'reserving a merge is not completion')
    await pool.query(`UPDATE factory_merges SET status='merged' WHERE id=$1`, [merge])
    await pool.query(`UPDATE factory_merges SET status='merged' WHERE id=$1`, [merge])
    const actions = (await list(owner, workspace, 'done')).items.map(i => i.completion!.action)
    assert.equal(actions.length, 6)
    assert.equal(actions.filter(a => a === 'approved').length, 1)
    assert.equal(actions.filter(a => a === 'merged').length, 1)
    assert.equal(actions.filter(a => a === 'answered').length, 2, 'the question and its display message deduplicate')
  })
  await t.test('keyset pagination preserves equal-time receipts and workspace isolation', async () => {
    await pool.query(`UPDATE inbox_history SET "createdAt"='2030-01-01T00:00:00.123456Z'`)
    const seen = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await list(owner, workspace, 'done', 1, cursor)
      assert.ok(page.historySince)
      assert.equal(page.items.length, 1)
      const id = page.items[0].completion!.id
      assert.ok(!seen.has(id)); seen.add(id)
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    assert.equal(seen.size, 6)
    assert.equal((await list(owner, other, 'done')).items.length, 0)
    await assert.rejects(list(owner, workspace, 'done', 50, 'invalid'), { code: 'inboxInvalid' })
  })
  await t.test('HTTP authentication, origin, workspace token scope and validation', async () => {
    const url = `https://mikka.test/api/inbox?workspaceId=${workspace}`
    const get = () => new Request(url)
    assert.equal((await handleInbox(get(), null, store)).status, 401)
    assert.equal((await handleInbox(get(), { id: owner, [tokenWorkspace]: other }, store)).status, 403)
    const response = await handleInbox(get(), { id: owner }, store)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).historyBackfilled, false)
    assert.equal((await handleInbox(new Request('https://mikka.test/api/inbox?tab=wrong'), { id: owner }, store)).status, 422)
    const command = { workspaceId: workspace, type: 'task', id: issue, action: 'reopen' }
    assert.equal((await handleInbox(new Request(url, { method: 'POST', body: JSON.stringify(command) }), { id: owner }, store)).status, 403)
    assert.equal((await handleInbox(new Request(url, { method: 'POST', headers: { origin: 'https://mikka.test' }, body: JSON.stringify(command) }), { id: owner }, store)).status, 200)
    assert.equal((await handleInbox(new Request(url, { method: 'POST', headers: { origin: 'https://mikka.test' }, body: '{' }), { id: owner }, store)).status, 422)
    await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [workspace, owner])
    assert.equal((await handleInbox(get(), { id: owner }, store)).status, 403)
  })
})
