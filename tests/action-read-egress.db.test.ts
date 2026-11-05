import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Client, type QueryResult } from 'pg'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { withActivitySession } from './fixtures/activity-runtime.mjs'
import { currentRoute } from '../lib/tracing/labels'

const enabled = disposableDatabase()
if (process.env.REQUIRE_DB === '1' && !enabled) throw Error('Action read egress requires a disposable loopback *_e2e database')

type Read = { fields: string[]; rows: number; bytes: number; route: string | undefined; text: string }
const reads: Read[] = []
let observing = false
const originalQuery = Client.prototype.query as (...args: unknown[]) => unknown
Client.prototype.query = function (this: Client, ...args: unknown[]) {
  const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text ?? ''
  const route = currentRoute()
  const observe = (result: QueryResult | QueryResult[]) => {
    if (!observing) return
    for (const value of Array.isArray(result) ? result : [result]) {
      if (value.command === 'SELECT') reads.push({ fields: value.fields.map(field => field.name), rows: value.rows.length, bytes: Buffer.byteLength(JSON.stringify(value.rows)), route, text })
    }
  }
  const callback = args.at(-1)
  if (typeof callback === 'function') {
    return Reflect.apply(originalQuery, this, [...args.slice(0, -1), (error: unknown, result: QueryResult) => {
      if (!error) observe(result)
      return callback(error, result)
    }])
  }
  const result = Reflect.apply(originalQuery, this, args)
  return result instanceof Promise ? result.then(value => { observe(value); return value }) : result
} as typeof Client.prototype.query

async function measured<T>(work: () => Promise<T>) {
  reads.length = 0; observing = true
  try { return { value: await work(), reads: [...reads] } } finally { observing = false }
}

test('task run rows keep the newest owner run and the 200-row limit without unused fields', { skip: !enabled }, async t => {
  const { pool, db } = await import('../lib/db')
  const { and, desc, eq, isNotNull, sql } = await import('drizzle-orm')
  const { agentRuns, agents, issues } = await import('../lib/db/schema')
  const { runAgentName, runBotId } = await import('../lib/run-bot-name')
  const { pollTaskRuns } = await import('../app/actions/task-runs')
  const poll = (userId: string): ReturnType<typeof pollTaskRuns> => withActivitySession(userId, () => pollTaskRuns())
  const owner = 'action-runs-' + randomUUID(), peer = 'action-peer-' + randomUUID()
  const agent = randomUUID(), issueIds = Array.from({ length: 201 }, () => randomUUID()).sort()
  const newest = randomUUID(), peerRun = randomUUID(), oldRun = randomUUID(), peerIssue = randomUUID()
  try {
    for (const user of [owner, peer]) await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())', [user, user + '@example.invalid'])
    await pool.query('INSERT INTO agents(id,"userId",name,harness) VALUES($1,$2,$3,$4)', [agent, owner, 'Read fixture', 'codex'])
    await pool.query('INSERT INTO issues(id,"userId",title,content,status,priority) SELECT id,$2,\'Read fixture\',\'{}\',\'todo\',\'normal\' FROM unnest($1::uuid[]) id', [issueIds, owner])
    await pool.query('INSERT INTO issues(id,"userId",title,content,status,priority) VALUES($1,$2,\'Peer\',\'{}\',\'todo\',\'normal\')', [peerIssue, peer])
    await pool.query('INSERT INTO agent_runs(id,"userId","issueId","agentId",status,prompt,error,"createdAt","finishedAt") SELECT gen_random_uuid(),$2,id,$3,\'failed\',\'Task fixture\',$4,now()-interval \'1 hour\',now() FROM unnest($1::uuid[]) id', [issueIds, owner, agent, 'subscriptionQuotaReached\n' + 'cause '.repeat(1_000)])
    await pool.query('INSERT INTO agent_runs(id,"userId","issueId","agentId",status,prompt,"createdAt") VALUES($1,$2,$3,$4,\'running\',\'newest\',now()),($5,$6,$9,$4,\'running\',\'peer\',now()),($7,$2,$8,$4,\'running\',\'expired\',now()-interval \'31 days\')', [newest, owner, issueIds[0], agent, peerRun, peer, oldRun, issueIds[1], peerIssue])
    // The pre-change projection on these exact rows supplies a measured byte baseline.
    const baseline = await measured(() => db.selectDistinctOn([agentRuns.issueId], {
      issueId: agentRuns.issueId, runId: agentRuns.id, issueTitle: issues.title, agentId: agentRuns.agentId, agentName: runAgentName,
      status: agentRuns.status, outcome: agentRuns.outcome, error: agentRuns.error, finishedAt: agentRuns.finishedAt, botId: runBotId,
      expiresAt: sql<Date | null>`(select min(r."createdAt")+interval '30 days' from agent_runs r where r."issueId"=${agentRuns.issueId} and r."userId"=${agentRuns.userId} and r."createdAt">now()-interval '30 days')`,
      harnesses: sql<string[]>`array(select a.harness from agent_runs r join agents a on a.id=r."agentId" where r."issueId"=${agentRuns.issueId} and r."userId"=${agentRuns.userId} and r."createdAt">now()-interval '30 days' group by a.harness order by max(r."createdAt") desc)`,
    }).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId)).innerJoin(issues, eq(issues.id, agentRuns.issueId))
      .where(and(eq(agentRuns.userId, owner), isNotNull(agentRuns.issueId), sql`${agentRuns.createdAt}>now()-interval '30 days'`))
      .orderBy(agentRuns.issueId, desc(agentRuns.createdAt), desc(agentRuns.id)).limit(200))
    const result = await measured(() => poll(owner))
    const selected = result.reads.find(read => read.text.startsWith('select distinct on'))
    assert.ok(selected)
    t.diagnostic(JSON.stringify({ read: 'task-runs', rowCount: selected.rows, beforeResultBytes: baseline.reads[0].bytes, resultBytes: selected.bytes, actionBytes: Buffer.byteLength(JSON.stringify(result.value)), fields: selected.fields }))
    assert.deepEqual(result.value.items, baseline.value.map(({ agentId: _agentId, error: _error, finishedAt: _finishedAt, botId: _botId, expiresAt: _expiry, ...row }) => ({ ...row, issueId: row.issueId!, bot: null })))
    assert.equal(result.value.items.length, 200)
    assert.equal(result.value.items.find(row => row.issueId === issueIds[0])?.runId, newest)
    assert.ok(result.value.items.every(row => row.runId !== peerRun && row.runId !== oldRun))
    assert.ok(result.value.items.every(row => row.agentName === 'Codex' && row.harnesses.includes('codex')))
    for (const field of ['agentId', 'error', 'finishedAt']) {
      assert.equal(selected.fields.includes(field), false, field + ' is not read for the list')
      assert.ok(result.value.items.every(row => !(field in row)), field + ' is not transported to the browser')
    }
    assert.equal(selected.route, '/actions/task-runs/read')
    assert.deepEqual((await poll(peer)).items.map(row => row.runId), [peerRun])
  } finally {
    await pool.query('DELETE FROM agent_runs WHERE "agentId"=$1', [agent])
    await pool.query('DELETE FROM agents WHERE id=$1', [agent])
    await pool.query('DELETE FROM issues WHERE id=ANY($1::uuid[])', [[...issueIds, peerIssue]])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[owner, peer]])
  }
})

test('task thread lists retain exact titles, summaries and privacy while details retain full errors', { skip: !enabled }, async t => {
  const { pool, db } = await import('../lib/db')
  const { desc, eq, sql } = await import('drizzle-orm')
  const { agentRuns, agents, users } = await import('../lib/db/schema')
  const { runBotName, runBotId } = await import('../lib/run-bot-name')
  const { pollIssueThreads, getIssueThread } = await import('../app/actions/agents')
  const poll = (userId: string, issueId: string): ReturnType<typeof pollIssueThreads> => withActivitySession(userId, () => pollIssueThreads(issueId))
  const { threadName } = await import('../lib/issue-threads')
  const { runSummaryText } = await import('../lib/issue-run-conversation')
  const owner = 'action-thread-' + randomUUID(), peer = 'thread-peer-' + randomUUID(), outsider = 'thread-other-' + randomUUID()
  const issue = randomUUID(), agent = randomUUID(), peerAgent = randomUUID()
  const filler = 'private payload '.repeat(4_000)
  const prompts = [
    '\n ## **Fix** the race\n' + filler,
    ('# \n> \n**\n').repeat(100) + 'A title after empty markdown\n' + filler,
    ' \t\u00a0\u2000\uFEFF\n> 17) **中文🙂** ' + '长'.repeat(100) + '\n' + filler,
    '\u0060\u0060\u0060\nconst value = 1\n\u0060\u0060\u0060\n' + filler,
    '# '.repeat(300) + 'Nested prefixes\n' + filler,
    '🙂'.repeat(61) + '\n' + filler,
    'Only title',
    '\u00a0\u2003\u2028\uFEFF',
    '**# literal heading after bold removal**\n' + filler,
    'Normal\r\n' + filler,
  ]
  const reports: unknown[] = [{ summary: ' \uFEFF Summary retained \u00a0 ', files: filler }, { summary: 9, notes: filler }, null, ['array', filler], { summary: '\u2002\uFEFF', notes: filler }, { summary: { text: filler } }]
  const error = '\n\u00a0\u2003\n subscriptionQuotaReached\u00a0 \nReason detail is kept\n' + filler
  const ids: string[] = Array.from({ length: 21 }, () => randomUUID())
  const peerId = randomUUID(), workspace = randomUUID(), team = randomUUID()
  try {
    for (const user of [owner, peer, outsider]) await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())', [user, user + '@example.invalid'])
    await pool.query('INSERT INTO agents(id,"userId",name,harness) VALUES($1,$2,\'Read fixture\',\'codex\'),($3,$4,\'Peer fixture\',\'claude_code\')', [agent, owner, peerAgent, peer])
    await pool.query('INSERT INTO issues(id,"userId",title,content,status,priority,scope) VALUES($1,$2,\'Threads\',\'{}\',\'todo\',\'normal\',\'workspace\')', [issue, owner])
    await pool.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,\'Thread scope\')', [workspace, owner])
    for (const user of [owner, peer]) await pool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,\'member\',\'active\')', [workspace, user, user + '@example.invalid'])
    await pool.query('INSERT INTO mikka_teams(id,"workspaceId","userId",name,identifier) VALUES($1,$2,$3,\'Thread scope\',\'THREAD\')', [team, workspace, owner])
    await pool.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)', [issue, team, workspace, owner])
    for (const [index, id] of ids.entries()) await pool.query('INSERT INTO agent_runs(id,"userId","issueId","agentId",status,prompt,report,error,"createdAt","finishedAt") VALUES($1,$2,$3,$4,\'failed\',$5,$6,$7,now()-($8*interval \'1 minute\'),now())', [id, owner, issue, agent, prompts[index % prompts.length], reports[index % reports.length] === null ? null : JSON.stringify(reports[index % reports.length]), error, index + 1])
    await pool.query('INSERT INTO agent_runs(id,"userId","issueId","agentId",status,prompt,report,error) VALUES($1,$2,$3,$4,\'failed\',$5,$6,$7)', [peerId, peer, issue, peerAgent, 'Peer secret\n' + filler, JSON.stringify({ summary: 'Peer summary', files: filler }), error])
    const baseline = await measured(() => db.select({
      id: agentRuns.id, issueId: agentRuns.issueId, userId: agentRuns.userId, status: agentRuns.status, prompt: agentRuns.prompt,
      sessionId: agentRuns.sessionId, deviceRepoId: agentRuns.deviceRepoId, report: agentRuns.report, error: agentRuns.error,
      createdAt: agentRuns.createdAt, finishedAt: agentRuns.finishedAt, agentName: runBotName, harness: agents.harness, ownerName: users.name,
      stopRequestedAt: agentRuns.stopRequestedAt, outcome: agentRuns.outcome,
      botColor: sql<string | null>`(select b.color from bots b where b.id=${runBotId})`,
      botShape: sql<string | null>`(select b.shape from bots b where b.id=${runBotId})`,
    }).from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId)).leftJoin(users, eq(users.id, agentRuns.userId))
      .where(eq(agentRuns.issueId, issue)).orderBy(desc(agentRuns.createdAt), desc(agentRuns.id)).limit(20))
    const result = await measured(() => poll(owner, issue))
    const selected = result.reads.find(read => read.fields.includes('harness') && read.fields.includes('name'))
    assert.ok(selected)
    t.diagnostic(JSON.stringify({ read: 'issue-thread-list', rowCount: selected.rows, beforeResultBytes: baseline.reads[0].bytes, resultBytes: selected.bytes, actionBytes: Buffer.byteLength(JSON.stringify(result.value)), fields: selected.fields }))
    assert.equal(result.value.threads.length, 20)
    assert.equal(result.value.threads[0].id, peerId)
    assert.equal(result.value.threads[0].detail, null)
    assert.equal(result.value.threads[0].ownedByCurrentUser, false)
    assert.equal(result.value.threads[0].ownerName, peer)
    for (const row of result.value.threads.filter(row => row.ownedByCurrentUser)) {
      const index = ids.indexOf(row.id)
      assert.equal(row.detail?.name, threadName(prompts[index % prompts.length], 'Read fixture'))
      assert.equal(row.detail?.summary, runSummaryText({ report: reports[index % reports.length], error }))
    }
    const detail = await withActivitySession(owner, () => getIssueThread(issue, ids[1]))
    assert.equal(detail.thread.prompt, prompts[1])
    assert.equal(detail.thread.error, error, 'detail preserves the entire error and its reason')
    await assert.rejects(withActivitySession(peer, () => getIssueThread(issue, ids[0])), { code: 'runNotFound' })
    await assert.rejects(withActivitySession(outsider, () => pollIssueThreads(issue)), { code: 'issueNotFound' })
    assert.ok(selected.bytes < baseline.reads[0].bytes / 20, 'list projection excludes full prompts, reports and error stacks')
    assert.equal(selected.route, '/actions/threads/issue-list')
    assert.ok(!selected.fields.includes('sessionId') && !selected.fields.includes('deviceRepoId'), 'detail-only identifiers stay out of the list')
  } finally {
    await pool.query('DELETE FROM agent_runs WHERE "issueId"=$1', [issue])
    await pool.query('DELETE FROM agents WHERE id=ANY($1::uuid[])', [[agent, peerAgent]])
    await pool.query('DELETE FROM mikka_team_issues WHERE "issueId"=$1', [issue])
    await pool.query('DELETE FROM mikka_teams WHERE id=$1', [team])
    await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1', [workspace])
    await pool.query('DELETE FROM mikka_workspaces WHERE id=$1', [workspace])
    await pool.query('DELETE FROM issues WHERE id=$1', [issue])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[owner, peer, outsider]])
  }
})

test('team link reads page through all authorized pairs and retain explicit-id scope checks', { skip: !enabled }, async t => {
  const { pool } = await import('../lib/db')
  const { issueTeamScope } = await import('../lib/issue-team-access')
  const owner = 'action-links-' + randomUUID()
  const workspace = randomUUID(), otherWorkspace = randomUUID(), team = randomUUID(), foreignTeam = randomUUID()
  const ids = Array.from({ length: 260 }, () => randomUUID()).sort()
  const wrongPair = randomUUID(), foreign = randomUUID()
  const allowed = [{ id: team, workspaceId: workspace }]
  try {
    await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())', [owner, owner + '@example.invalid'])
    await pool.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$3,\'Read scope\'),($2,$3,\'Other scope\')', [workspace, otherWorkspace, owner])
    await pool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,\'admin\',\'active\')', [workspace, owner, owner + '@example.invalid'])
    await pool.query('INSERT INTO mikka_teams(id,"workspaceId","userId",name,identifier) VALUES($1,$2,$5,\'Read scope\',\'READ\'),($3,$4,$5,\'Other scope\',\'OTHER\')', [team, workspace, foreignTeam, otherWorkspace, owner])
    await pool.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") SELECT id,$2,$3,$4 FROM unnest($1::uuid[]) id', [ids, team, workspace, owner])
    await pool.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4),($5,$6,$3,$4)', [wrongPair, team, otherWorkspace, owner, foreign, foreignTeam])
    const sampleIds = ids.slice(0, 110)
    const baseline = await measured(() => pool.query({ text: 'SELECT "issueId","teamId","workspaceId" FROM mikka_team_issues WHERE "issueId"=ANY($1::uuid[]) ORDER BY "issueId"', values: [sampleIds], rowMode: 'array' }))
    const sample = await measured(() => issueTeamScope(owner, [], { onlyIssueIds: sampleIds, teams: allowed }))
    assert.equal(sample.value.length, 110)
    t.diagnostic(JSON.stringify({ read: 'team-links-110', beforeResultBytes: baseline.reads[0].bytes, afterResultBytes: sample.reads.reduce((sum, read) => sum + read.bytes, 0) }))
    const all = await measured(() => issueTeamScope(owner))
    assert.deepEqual(all.value.map(row => row.issueId).sort(), ids)
    assert.ok(all.value.every(row => row.teamId === team && row.workspaceId === workspace))
    const pages = all.reads.filter(read => read.fields.includes('issueId'))
    t.diagnostic(JSON.stringify({ read: 'team-links-paged', pages: pages.map(page => ({ rows: page.rows, bytes: page.bytes, fields: page.fields })) }))
    assert.ok(pages.length >= 3 && pages.every(page => page.rows <= 128), 'every page is bounded and later pages are not lost')
    assert.ok(pages.every(page => !page.fields.includes('workspaceId')), 'authorized workspace is reconstructed from the same-operation pair')
    assert.deepEqual(await issueTeamScope(owner, [], { onlyIssueIds: [], teams: allowed }), [])
    const explicit = await issueTeamScope(owner, [foreign, wrongPair], { onlyIssueIds: [foreign, wrongPair], teams: allowed })
    assert.equal(explicit.find(row => row.issueId === foreign)?.workspaceId, otherWorkspace, 'explicit IDs preserve other-workspace links for token checks')
    assert.equal(explicit.find(row => row.issueId === wrongPair)?.workspaceId, otherWorkspace)
    await pool.query('UPDATE mikka_workspace_members SET status=\'removed\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace, owner])
    assert.deepEqual(await issueTeamScope(owner), [], 'membership is re-read on the next operation')
  } finally {
    await pool.query('DELETE FROM mikka_team_issues WHERE "teamId"=ANY($1::uuid[])', [[team, foreignTeam]])
    await pool.query('DELETE FROM mikka_teams WHERE id=ANY($1::uuid[])', [[team, foreignTeam]])
    await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=ANY($1::uuid[])', [[workspace, otherWorkspace]])
    await pool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [[workspace, otherWorkspace]])
    await pool.query('DELETE FROM "user" WHERE id=$1', [owner])
  }
})
