import { seedFixtureWorkspace } from './helpers/task-workspace'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
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
  const runtimeAgent = randomUUID(), runtimeDevice = randomUUID(), runtimeRepo = randomUUID(), workspace = randomUUID()
  const [boundBot, directBot, runtimeBot, peerBot] = Array.from({ length: 4 }, () => randomUUID())
  const botLooks = [boundBot, directBot, runtimeBot].map((id, index) => ({ id, name: 'Read bot ' + index, color: 'encre', shape: 'cercle' }))
  const newest = randomUUID(), peerRun = randomUUID(), oldRun = randomUUID(), peerIssue = randomUUID()
  try {
    for (const user of [owner, peer]) await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())', [user, user + '@example.invalid'])
    await seedFixtureWorkspace(pool, owner, 'personal', workspace)
    for (const [index, id] of [agent, runtimeAgent].entries()) await pool.query('INSERT INTO agents(id,"userId",name,harness) VALUES($1,$2,$3,$4)', [id, owner, 'Read fixture ' + index, 'codex'])
    for (const bot of botLooks) await pool.query('INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,$2,$3,$4)', [bot.id, owner, workspace, bot.name])
    await pool.query('INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,$2,$3,\'Peer bot\')', [peerBot, peer, workspace])
    await pool.query('INSERT INTO devices(id,"ownerId",name) VALUES($1,$2,\'Read fixture\')', [runtimeDevice, owner])
    await pool.query('INSERT INTO device_repos(id,"userId","deviceId","repoPath","remoteUrl","baseBranch") VALUES($1,$2,$3,\'/fixture\',\'https://github.com/mikka-fixture/read.git\',\'main\')', [runtimeRepo, owner, runtimeDevice])
    await pool.query('INSERT INTO bot_cloud_runtimes("botId","workspaceId","ownerId",harness,"agentId","repoId") VALUES($1,$2,$3,\'codex\',$4,$5)', [runtimeBot, workspace, owner, runtimeAgent, runtimeRepo])
    await pool.query('INSERT INTO issues(id,"userId",title,content,status,priority,"workspaceId","ownershipState") SELECT id,$2,\'Read fixture\',\'{}\',\'todo\',\'normal\',$3,\'bound\' FROM unnest($1::uuid[]) id', [issueIds, owner, await seedFixtureWorkspace(pool, owner)])
    await pool.query('INSERT INTO issues(id,"userId",title,content,status,priority,"workspaceId","ownershipState") VALUES($1,$2,\'Peer\',\'{}\',\'todo\',\'normal\',$3,\'bound\')', [peerIssue, peer, await seedFixtureWorkspace(pool, peer)])
    await pool.query('INSERT INTO agent_runs(id,"userId","issueId","agentId",status,prompt,error,"createdAt","finishedAt") SELECT gen_random_uuid(),$2,id,$3,\'failed\',\'Task fixture\',$4,now()-interval \'1 hour\',now() FROM unnest($1::uuid[]) id', [issueIds, owner, agent, 'subscriptionQuotaReached\n' + 'cause '.repeat(1_000)])
    await pool.query('INSERT INTO agent_runs(id,"userId","issueId","agentId",status,prompt,"createdAt") VALUES($1,$2,$3,$4,\'running\',\'newest\',now()),($5,$6,$9,$4,\'running\',\'peer\',now()),($7,$2,$8,$4,\'running\',\'expired\',now()-interval \'31 days\')', [newest, owner, issueIds[0], agent, peerRun, peer, oldRun, issueIds[1], peerIssue])
    await pool.query('UPDATE agent_runs SET "botId"=$2 WHERE id=$1 OR ("issueId"=$3 AND "userId"=$4)', [newest, directBot, issueIds[1], owner])
    await pool.query('INSERT INTO computer_run_bindings("runId","botId","workspaceId","ownerId") VALUES($1,$2,$3,$4)', [newest, boundBot, workspace, owner])
    await pool.query('UPDATE agent_runs SET "botId"=$2 WHERE "issueId"=$1 AND "userId"=$3', [issueIds[2], peerBot, owner])
    await pool.query('UPDATE agent_runs SET "agentId"=$2 WHERE "issueId"=$1 AND "userId"=$3', [issueIds[3], runtimeAgent, owner])
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
    const selected = result.reads.find(read => read.text.includes('from (select distinct on'))
    assert.ok(selected)
    assert.equal(result.reads.filter(read => read.text.includes('from (select distinct on')).length, 1)
    assert.equal(result.reads.some(read => /from "bots" where/.test(read.text)), false, 'bot looks do not add a separate statement')
    t.diagnostic(JSON.stringify({ read: 'task-runs', rowCount: selected.rows, beforeResultBytes: baseline.reads[0].bytes, resultBytes: selected.bytes, actionBytes: Buffer.byteLength(JSON.stringify(result.value)), fields: selected.fields }))
    assert.deepEqual(result.value.items, baseline.value.map(({ agentId: _agentId, error: _error, finishedAt: _finishedAt, botId, expiresAt: _expiry, ...row }) => ({ ...row, issueId: row.issueId!, bot: botLooks.find(bot => bot.id === botId) ?? null, failureDetails: null })))
    assert.equal(result.value.items.length, 200)
    assert.equal(result.value.items.find(row => row.issueId === issueIds[0])?.runId, newest)
    assert.deepEqual(issueIds.slice(0, 4).map(id => result.value.items.find(row => row.issueId === id)?.bot?.id ?? null), [boundBot, directBot, null, runtimeBot], 'binding wins, direct and runtime fallbacks survive, and foreign bots remain private')
    assert.ok(result.value.items.every(row => row.runId !== peerRun && row.runId !== oldRun))
    assert.ok(result.value.items.every(row => row.agentName === 'Codex' && row.harnesses.includes('codex')))
    for (const field of ['agentId', 'error', 'finishedAt']) {
      assert.equal(selected.fields.includes(field), false, field + ' is not read for the list')
      assert.ok(result.value.items.every(row => !(field in row)), field + ' is not transported to the browser')
    }
    assert.equal(selected.route, '/actions/task-runs/read')
    assert.deepEqual((await poll(peer)).items.map(row => row.runId), [peerRun])
  } finally {
    await pool.query('DELETE FROM agent_runs WHERE "agentId"=ANY($1::uuid[])', [[agent, runtimeAgent]])
    await pool.query('DELETE FROM agents WHERE id=ANY($1::uuid[])', [[agent, runtimeAgent]])
    await pool.query('DELETE FROM device_repos WHERE id=$1', [runtimeRepo])
    await pool.query('DELETE FROM devices WHERE id=$1', [runtimeDevice])
    await pool.query('DELETE FROM bots WHERE id=ANY($1::uuid[])', [[boundBot, directBot, runtimeBot, peerBot]])
    await pool.query('DELETE FROM issues WHERE id=ANY($1::uuid[])', [[...issueIds, peerIssue]])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[owner, peer]])
  }
})

test('one bounded snapshot aggregate preserves the old fingerprint and exact expiry, including empty rows', { skip: !enabled }, async () => {
  const { sql } = await import('drizzle-orm')
  const { queryVersion, queryVersionWithExpiry } = await import('../lib/db/query-version')
  const snapshot = sql`select id, "createdAt" from (values
    (1, '2020-01-01T00:00:00Z'::timestamptz), (2, '2020-01-02T00:00:00Z'::timestamptz),
    (3, '2020-01-03T00:00:00Z'::timestamptz)) as bounded(id, "createdAt") order by "createdAt" desc limit 2`
  const oldVersion = await queryVersion(snapshot)
  const result = await measured(() => queryVersionWithExpiry(snapshot, sql`min(snapshot."createdAt")+interval '30 days'`))
  assert.equal(result.value.version, oldVersion, 'adding expiry does not change the hash or its row projection')
  assert.equal(new Date(result.value.expiresAt!).toISOString(), '2020-02-01T00:00:00.000Z', 'the expiry uses only the same bounded rows')
  assert.equal(result.reads.length, 1)
  assert.deepEqual(result.reads[0].fields, ['version', 'expiresAt'])
  assert.equal(result.reads[0].rows, 1, 'the bounded rows stay inside PostgreSQL')
  const empty = sql`select 1 as id, now() as "createdAt" where false`
  const emptyVersion = await queryVersion(empty)
  const absent = await measured(() => queryVersionWithExpiry(empty, sql`min(snapshot."createdAt")+interval '30 days'`))
  assert.deepEqual(absent.value, { version: emptyVersion, expiresAt: null })
  assert.equal(absent.reads.length, 1)
})

test('task thread lists retain exact titles, summaries and privacy while details retain full errors', { skip: !enabled }, async t => {
  const { pool, db } = await import('../lib/db')
  const { desc, eq, sql } = await import('drizzle-orm')
  const { agentRuns, agents, users } = await import('../lib/db/schema')
  const { runBotName, runBotId } = await import('../lib/run-bot-name')
  const { pollIssueThreads, getIssueThread } = await import('../app/actions/agents')
  const poll = (userId: string, issueId: string): ReturnType<typeof pollIssueThreads> => withActivitySession(userId, () => pollIssueThreads(issueId), workspace)
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
    await pool.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,\'Thread scope\')', [workspace, owner])
    await pool.query('INSERT INTO issues(id,"userId",title,content,status,priority,scope,"workspaceId","ownershipState") VALUES($1,$2,\'Threads\',\'{}\',\'todo\',\'normal\',\'workspace\',$3,\'bound\')', [issue, owner, workspace])
    for (const user of [owner, peer]) await pool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,\'member\',\'active\')', [workspace, user, user + '@example.invalid'])
    await pool.query('INSERT INTO mikka_teams(id,"workspaceId","userId",name,identifier) VALUES($1,$2,$3,\'Thread scope\',\'THREAD\')', [team, workspace, owner])
    await pool.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)', [issue, team, workspace, owner])
    for (const [index, id] of ids.entries()) await pool.query('INSERT INTO agent_runs(id,"userId","issueId","agentId",status,prompt,report,error,"createdAt","finishedAt","promptTaskStart","promptTaskLength") VALUES($1,$2,$3,$4,\'failed\',$5,$6,$7,now()-($8*interval \'1 minute\'),now(),0,char_length($5))', [id, owner, issue, agent, prompts[index % prompts.length], reports[index % reports.length] === null ? null : JSON.stringify(reports[index % reports.length]), error, index + 1])
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
    const detail = await withActivitySession(owner, () => getIssueThread(issue, ids[1]), workspace)
    assert.equal(detail.thread.prompt, prompts[1])
    assert.equal(detail.thread.error, error, 'detail preserves the entire error and its reason')
    await assert.rejects(withActivitySession(peer, () => getIssueThread(issue, ids[0]), workspace), { code: 'runNotFound' })
    await assert.rejects(withActivitySession(outsider, () => pollIssueThreads(issue), workspace), { code: 'issueNotFound' })
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
    await pool.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)', [foreign, foreignTeam, otherWorkspace, owner])
    // The lifecycle constraint now rejects new malformed pairs at the write
    // boundary. Keep the foreign but internally consistent link for explicit
    // token-scope reads; do not disable the production guard to seed corruption.
    await assert.rejects(pool.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)', [wrongPair, team, otherWorkspace, owner]), { code: '23514', message: 'workspaceAccessDenied' })
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
    assert.equal(explicit.find(row => row.issueId === wrongPair), undefined, 'a rejected malformed relation is never materialized by an explicit-id read')
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


test('thread identity reads keep owner-only, live membership and checkpoint behavior with bounded fields', { skip: !enabled }, async t => {
  const { pool, db } = await import('../lib/db')
  const { and, eq, isNull, sql } = await import('drizzle-orm')
  const { agentRuns, agents, users } = await import('../lib/db/schema')
  const { runBotName, runBotId } = await import('../lib/run-bot-name')
  const { findThreadIssue, getThreadChanges } = await import('../app/actions/agents')
  const owner = 'thread-identity-' + randomUUID(), peer = 'thread-peer-' + randomUUID(), outsider = 'thread-outsider-' + randomUUID()
  const workspace = randomUUID(), personalWorkspace = randomUUID(), team = randomUUID(), issue = randomUUID(), bot = randomUUID()
  const agent = randomUUID(), peerAgent = randomUUID()
  const linked = randomUUID(), peerRun = randomUUID(), solo = randomUUID(), botRun = randomUUID()
  const runIds = [linked, peerRun, solo, botRun]
  const filler = 'private payload '.repeat(600)
  const find = (userId: string, runId: string) => withActivitySession(userId, () => findThreadIssue(runId), runId === solo ? personalWorkspace : workspace)
  const changes = (userId: string, issueId: string | null, runId: string) => withActivitySession(userId, () => getThreadChanges(issueId, runId), issueId === null && runId === solo ? personalWorkspace : workspace)
  // The old row projection is measured on the same IDs, joins and limits as the
  // real actions. These JSON result bytes are not PostgreSQL/Neon wire bytes.
  const fullColumns = {
    id: agentRuns.id, issueId: agentRuns.issueId, userId: agentRuns.userId, status: agentRuns.status, prompt: agentRuns.prompt,
    sessionId: agentRuns.sessionId, deviceRepoId: agentRuns.deviceRepoId, report: agentRuns.report, error: agentRuns.error,
    createdAt: agentRuns.createdAt, finishedAt: agentRuns.finishedAt, agentName: runBotName, harness: agents.harness, ownerName: users.name,
    stopRequestedAt: agentRuns.stopRequestedAt, outcome: agentRuns.outcome,
    botColor: sql<string | null>`(select b.color from bots b where b.id=${runBotId})`,
    botShape: sql<string | null>`(select b.shape from bots b where b.id=${runBotId})`,
  }
  const taskFreeColumns = {
    botWorkspaceId: sql<string | null>`(select b."workspaceId" from bots b where b.id=${runBotId})`,
    hasBot: sql<boolean>`${runBotId} is not null`,
  }
  try {
    for (const user of [owner, peer, outsider]) await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())', [user, user + '@example.invalid'])
    await pool.query('INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES($1,$2,\'Thread identity\',\'team\')', [workspace, owner])
    for (const user of [owner, peer]) await pool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,\'member\',\'active\')', [workspace, user, user + '@example.invalid'])
    await pool.query('INSERT INTO mikka_teams(id,"workspaceId","userId",name,identifier) VALUES($1,$2,$3,\'Thread identity\',\'IDENTITY\')', [team, workspace, owner])
    await pool.query('INSERT INTO issues(id,"userId",title,content,status,priority,scope,"workspaceId","ownershipState") VALUES($1,$2,\'Thread identity\',\'{}\',\'todo\',\'normal\',\'workspace\',$3,\'bound\')', [issue, owner, workspace])
    await pool.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)', [issue, team, workspace, owner])
    await pool.query('INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,$2,$3,\'Thread identity\')', [bot, owner, workspace])
    await pool.query('INSERT INTO agents(id,"userId",name,harness) VALUES($1,$2,\'Read fixture\',\'codex\'),($3,$4,\'Peer fixture\',\'claude_code\')', [agent, owner, peerAgent, peer])
    await seedFixtureWorkspace(pool, owner, 'personal', personalWorkspace)
    for (const [id, userId, issueId, agentId, botId] of [[linked, owner, issue, agent, null], [peerRun, peer, issue, peerAgent, null], [solo, owner, null, agent, null], [botRun, owner, null, agent, bot]]) {
      await pool.query('INSERT INTO agent_runs(id,"userId","issueId","agentId","botId",status,prompt,report,error,"workspaceId") VALUES($1,$2,$3,$4,$5,\'failed\',$6,$7,$8,$9)', [id, userId, issueId, agentId, botId, 'Read identity\n' + filler, JSON.stringify({ summary: 'Read fixture', files: filler }), 'subscriptionQuotaReached\n' + filler, id === solo ? personalWorkspace : workspace])
    }
    await t.test('identity projections are bounded and every read has a fixed action source', async sub => {
      const samples: { read: Read; route: string; expectedFields: string[]; baselineBytes: number; scoped: boolean; queries: number; expectedQueries: number }[] = []
      for (const [label, runId, issueId] of [['linked', linked, issue], ['no-bot', solo, null], ['bot', botRun, null]] as const) {
        const baseline = await measured(() => db.select({ ...fullColumns, ...(issueId === null ? taskFreeColumns : {}) })
          .from(agentRuns).innerJoin(agents, eq(agents.id, agentRuns.agentId)).leftJoin(users, eq(users.id, agentRuns.userId))
          .where(and(eq(agentRuns.id, runId), issueId === null ? isNull(agentRuns.issueId) : eq(agentRuns.issueId, issueId))).limit(1))
        const located = await measured(() => find(owner, runId))
        assert.deepEqual(located.value, { issueId })
        const changed = await measured(() => changes(owner, issueId, runId))
        assert.deepEqual(changed.value, { state: 'none' })
        for (const [action, result] of [['find-issue', located], ['changes', changed]] as const) {
          const selected = result.reads.findLast(read => read.text.includes('from "agent_runs" inner join "agents"'))
          assert.ok(selected)
          const route = '/actions/threads/' + action
          const expectedQueries = label === 'linked' ? 6 : action === 'changes' ? 3 : 2
          if (result.reads.length !== expectedQueries) sub.diagnostic(JSON.stringify({ read: 'thread-' + action + '-' + label,
            queryShapes: result.reads.map(read => ({ tables: [...read.text.matchAll(/(?:from|join)\s+"?([a-z_]+)"?/gi)].map(match => match[1]), fields: read.fields })) }))
          sub.diagnostic(JSON.stringify({ read: 'thread-' + action + '-' + label, beforeResultBytes: baseline.reads[0].bytes, resultBytes: selected.bytes,
            selectQueries: result.reads.length, allResultBytes: result.reads.reduce((sum, read) => sum + read.bytes, 0), rowCount: selected.rows, fields: selected.fields }))
          samples.push({ read: selected, route, expectedFields: action === 'find-issue' && issueId === null ? ['id', 'userId', 'issueId', 'workspaceId'] : ['id', 'userId'], baselineBytes: baseline.reads[0].bytes, scoped: result.reads.every(read => read.route === route), queries: result.reads.length, expectedQueries })
        }
      }
      for (const sample of samples) {
        assert.equal(sample.queries, sample.expectedQueries, 'projection and source labels add no queries')
        assert.ok(sample.scoped, 'all reads inherit the fixed source, including ACL and checkpoint queries')
        assert.deepEqual(sample.read.fields, sample.expectedFields)
        assert.equal(sample.read.rows, 1)
        assert.ok(sample.read.bytes < 200 && sample.read.bytes < sample.baselineBytes / 100, 'authorization does not fetch prompt, report, errors or display fields')
        assert.ok(/limit \$\d+$/.test(sample.read.text), 'the run projection remains limited to one row')
      }
    })
    await t.test('both actions preserve owner, peer, missing and null-issue boundaries', async () => {
      assert.deepEqual(await find(peer, peerRun), { issueId: issue })
      assert.deepEqual(await changes(peer, issue, peerRun), { state: 'none' })
      for (const [userId, runId, issueId] of [[peer, linked, issue], [owner, peerRun, issue], [peer, solo, null], [peer, botRun, null]] as const) {
        assert.equal(await find(userId, runId), null)
        const denied = await measured(() => assert.rejects(changes(userId, issueId, runId), { code: 'runNotFound' }))
        assert.ok(denied.reads.every(read => !read.text.includes('FROM run_checkpoints')), 'denied readers never reach checkpoint content')
      }
      assert.equal(await find(outsider, linked), null)
      await assert.rejects(changes(outsider, issue, linked), { code: 'issueNotFound' })
      await assert.rejects(changes(owner, null, linked), { code: 'runNotFound' })
      await assert.rejects(changes(owner, issue, solo), { code: 'runNotFound' })
      const invalid = await measured(() => find(owner, 'not-a-uuid'))
      assert.equal(invalid.value, null); assert.equal(invalid.reads.length, 0)
      assert.equal(await find(owner, randomUUID()), null)
      await assert.rejects(changes(owner, null, 'not-a-uuid'), { code: 'runNotFound' })
      await assert.rejects(changes(owner, null, randomUUID()), { code: 'runNotFound' })
    })
    await t.test('the changes result still returns valid checkpoints and rejects unreadable gzip', async () => {
      const patch = 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-before\n+after\n'
      await pool.query('INSERT INTO run_checkpoints("runId","userId","baseCommit",patch,files,"takenAt") VALUES($1,$2,$3,$4,1,now())', [linked, owner, 'a'.repeat(40), gzipSync(patch)])
      const result = await changes(owner, issue, linked)
      assert.equal(result.state, 'ready')
      if (result.state !== 'ready') assert.fail('the valid checkpoint is readable')
      assert.equal(result.changes.files[0].path, 'README.md')
      await pool.query('UPDATE run_checkpoints SET "unavailableReason"=\'too_large\' WHERE "runId"=$1', [linked])
      assert.deepEqual(await changes(owner, issue, linked), { state: 'tooLarge' })
      await pool.query('UPDATE run_checkpoints SET "unavailableReason"=NULL,patch=$2 WHERE "runId"=$1', [linked, Buffer.from('not gzip')])
      assert.deepEqual(await changes(owner, issue, linked), { state: 'tooLarge' })
    })
    await t.test('the newest checkpoint follows only the same owner and workspace chain', async () => {
      const continued = randomUUID()
      runIds.push(continued)
      await pool.query('INSERT INTO agent_runs(id,"userId","issueId","agentId",status,"workspaceId","retryOf") VALUES($1,$2,$3,$4,\'failed\',$5,$6)', [continued, owner, issue, agent, workspace, linked])
      const patch = (file: string) => gzipSync(`diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-before\n+after\n`)
      for (const [id, userId, file, hours] of [[continued, owner, 'continued.md', 1], [peerRun, peer, 'peer-private.md', 2], [solo, owner, 'other-workspace.md', 3]] as const) {
        await pool.query('INSERT INTO run_checkpoints("runId","userId","baseCommit",patch,files,"takenAt","updatedAt") VALUES($1,$2,$3,$4,1,now(),now()+($5*interval \'1 hour\'))', [id, userId, 'a'.repeat(40), patch(file), hours])
      }
      for (const runId of [linked, continued]) {
        const result = await changes(owner, issue, runId)
        assert.equal(result.state, 'ready')
        if (result.state !== 'ready') assert.fail('the continuation checkpoint is readable')
        assert.deepEqual(result.changes.files.map(file => file.path), ['continued.md'])
      }
      await pool.query('DELETE FROM run_checkpoints WHERE "runId"=ANY($1::uuid[])', [[continued, peerRun, solo]])
    })
    await t.test('a cyclic chain fails before returning checkpoint content', async () => {
      const first = randomUUID(), second = randomUUID()
      runIds.push(first, second)
      for (const id of [first, second]) await pool.query('INSERT INTO agent_runs(id,"userId","agentId",status,"workspaceId") VALUES($1,$2,$3,\'failed\',$4)', [id, owner, agent, personalWorkspace])
      await pool.query('UPDATE agent_runs SET "retryOf"=$2 WHERE id=$1', [first, second])
      await pool.query('UPDATE agent_runs SET "retryOf"=$2 WHERE id=$1', [second, first])
      await assert.rejects(withActivitySession(owner, () => getThreadChanges(null, first), personalWorkspace), /runChainDepthExceeded/)
    })
    await t.test('suspension and removal are read afresh, including Bot threads without an issue', async () => {
      for (const status of ['suspended', 'removed']) {
        await pool.query('UPDATE mikka_workspace_members SET status=$3 WHERE "workspaceId"=$1 AND "userId"=$2', [workspace, owner, status])
        assert.equal(await find(owner, linked), null)
        await assert.rejects(changes(owner, issue, linked), { code: 'issueNotFound' })
        assert.equal(await find(owner, botRun), null)
        await assert.rejects(changes(owner, null, botRun), { code: 'runNotFound' })
        assert.deepEqual(await find(owner, solo), { issueId: null }, 'a task-free thread with no Bot remains private to its owner')
        assert.deepEqual(await changes(owner, null, solo), { state: 'none' })
      }
      await pool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace, owner])
      assert.deepEqual(await find(owner, linked), { issueId: issue })
      assert.deepEqual(await find(owner, botRun), { issueId: null })
      assert.deepEqual(await changes(owner, null, botRun), { state: 'none' })
    })
  } finally {
    await pool.query('DELETE FROM agent_runs WHERE id=ANY($1::uuid[]) AND "userId"=ANY($2::text[])', [runIds, [owner, peer]])
    await pool.query('DELETE FROM agents WHERE id=ANY($1::uuid[])', [[agent, peerAgent]])
    await pool.query('DELETE FROM bots WHERE id=$1 AND "ownerId"=$2', [bot, owner])
    await pool.query('DELETE FROM mikka_team_issues WHERE "issueId"=$1', [issue])
    await pool.query('DELETE FROM mikka_teams WHERE id=$1', [team])
    await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1', [workspace])
    await pool.query('DELETE FROM mikka_workspaces WHERE id=$1', [workspace])
    await pool.query('DELETE FROM issues WHERE id=$1', [issue])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[owner, peer, outsider]])
  }
})

test('task-run visibility skips unused team metadata without weakening fresh workspace authority', { skip: !enabled }, async t => {
  const { pool, db } = await import('../lib/db')
  const { pollTaskRuns } = await import('../app/actions/task-runs')
  const { issueVisibility } = await import('../lib/issue-visibility')
  const { issues } = await import('../lib/db/schema')
  const { createRequestScope, runRequestScope } = await import('../apps/api/src/context')
  const { activityFixtureSession } = await import('./fixtures/activity-runtime.mjs')
  const { tokenWorkspace } = await import('../lib/tokens/principal')
  const { enterprisePrincipal } = await import('../lib/enterprise/principal')
  const { bumpLiveRevisions } = await import('../lib/live/revisions')
  const { createRequire } = await import('node:module')
  const { statementStructure } = createRequire(import.meta.url)('../apps/desktop/test/db-query-diagnostics.cjs') as {
    statementStructure(text: string): { value?: { status: string; normalizedStructureId: string; command: string; parameterCount: number } }
  }
  const owner = 'task-run-scope-' + randomUUID(), peer = 'task-run-other-' + randomUUID()
  const personal = randomUUID(), selected = randomUUID(), foreign = randomUUID(), team = randomUUID(), agent = randomUUID()
  const personalIssue = randomUUID(), selectedIssue = randomUUID(), personalRun = randomUUID(), selectedRun = randomUUID()
  const links = [selectedIssue, ...Array.from({ length: 128 }, () => randomUUID())]
  type PrincipalOptions = { pin?: string; enterprise?: boolean }
  const asSelected = <T>(workspaceId: string, work: () => Promise<T>, principal: PrincipalOptions = {}) => withActivitySession(owner, () => {
    const session = activityFixtureSession()
    assert.ok(session?.user)
    if (principal.pin) Object.assign(session.user, { [tokenWorkspace]: principal.pin })
    if (principal.enterprise) Object.assign(session.user, { [enterprisePrincipal]: { kind: 'session', sessionId: session.session.id } })
    return runRequestScope(createRequestScope(new Request('http://localhost/api/desktop/rpc', {
      headers: { 'x-mikka-workspace-id': workspaceId },
    })), work)
  }, workspaceId)
  const poll = (workspaceId: string, principal: PrincipalOptions = {}) => asSelected(workspaceId, () => pollTaskRuns(), principal)
  const teamReads = (values: Read[]) => values.filter(read => /from "mikka_(teams|team_issues)"/.test(read.text))
  try {
    for (const user of [owner, peer]) await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())', [user, user + '@example.invalid'])
    await seedFixtureWorkspace(pool, owner, 'personal', personal)
    await seedFixtureWorkspace(pool, owner, 'team', selected)
    await seedFixtureWorkspace(pool, peer, 'personal', foreign)
    await pool.query('INSERT INTO agents(id,"userId",name,harness) VALUES($1,$2,\'Task visibility fixture\',\'codex\')', [agent, owner])
    for (const [issue, run, workspace] of [[personalIssue, personalRun, personal], [selectedIssue, selectedRun, selected]]) {
      await pool.query('INSERT INTO issues(id,"userId",title,content,status,priority,"workspaceId","ownershipState") VALUES($1,$2,\'Task visibility\',\'{}\',\'todo\',\'normal\',$3,\'bound\')', [issue, owner, workspace])
      await pool.query('INSERT INTO agent_runs(id,"userId","issueId","agentId","workspaceId",status,prompt) VALUES($1,$2,$3,$4,$5,\'running\',\'Task visibility\')', [run, owner, issue, agent, workspace])
    }
    await pool.query('INSERT INTO mikka_teams(id,"workspaceId","userId",name,identifier) VALUES($1,$2,$3,\'Task visibility\',\'VISIBILITY\')', [team, selected, owner])
    await pool.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") SELECT id,$2,$3,$4 FROM unnest($1::uuid[]) id', [links, team, selected, owner])
    const revisions = await bumpLiveRevisions(pool, [{ kind: 'task_run_list', id: selected }])

    await t.test('the existing no-links option keeps the exact real predicate and avoids two pages of unused links', async () => {
      const before = await measured(() => asSelected(selected, () => issueVisibility({ id: owner }, false, selected)))
      const after = await measured(() => asSelected(selected, () => issueVisibility({ id: owner }, false, selected, db, { withTeamLinks: false })))
      assert.equal(before.value.links.length, 129)
      assert.deepEqual(after.value.links, [])
      assert.deepEqual(before.value.workspaceIds, after.value.workspaceIds)
      const oldRows = db.select({ id: issues.id }).from(issues).where(before.value.predicate)
      const newRows = db.select({ id: issues.id }).from(issues).where(after.value.predicate)
      assert.deepEqual(newRows.toSQL(), oldRows.toSQL(), 'tenant, bound ownership and deleted-row predicate are byte-identical')
      assert.deepEqual(await oldRows, [{ id: selectedIssue }])
      assert.deepEqual(await newRows, [{ id: selectedIssue }])
      const scopeReads = before.reads.filter(read => read.text.includes('from "mikka_teams"'))
      assert.equal(scopeReads.length, 1)
      assert.deepEqual(statementStructure(scopeReads[0].text).value, {
        status: 'known', normalizedStructureId: '3a287aa80050', command: 'SELECT', parameterCount: 2,
      }, 'the real Drizzle query has the R2 task-run metadata fingerprint')
      assert.equal(before.reads.filter(read => read.text.includes('from "mikka_team_issues"')).length, 2)
      assert.equal(teamReads(after.reads).length, 0)
    })

    await t.test('the real task-run action reads no team metadata and still reads current tenant membership', async sub => {
      const result = await measured(() => poll(selected))
      assert.deepEqual(result.value.items.map(row => row.runId), [selectedRun])
      assert.equal(result.value.live.ownerId, owner)
      assert.equal(result.value.live.workspaceId, selected)
      assert.deepEqual(result.value.live.revisions, revisions, 'the same pre-data Live revision still reaches the caller')
      assert.equal(result.reads.filter(read => read.fields.join(',') === 'id,kind,organizationId'
        && read.text.includes('from "mikka_workspaces"')).length, 1, 'the operation still performs its fresh workspace-membership read')
      assert.ok(result.reads.every(read => read.route === '/actions/task-runs/read'))
      sub.diagnostic(JSON.stringify({ read: 'task-run-visibility', selectedRows: result.value.items.length,
        teamMetadataQueries: teamReads(result.reads).length, freshWorkspaceMembershipReads: result.reads.filter(read =>
          read.fields.join(',') === 'id,kind,organizationId' && read.text.includes('from "mikka_workspaces"')).length }))
      assert.equal(teamReads(result.reads).length, 0, 'task runs consume only the predicate, never team settings or link pages')
      assert.deepEqual((await poll(personal)).items.map(row => row.runId), [personalRun])
    })

    await t.test('token pinning and foreign-workspace denial remain on the original action path', async () => {
      assert.deepEqual((await poll(selected, { pin: selected })).items.map(row => row.runId), [selectedRun])
      await assert.rejects(poll(selected, { pin: personal }), { code: 'workspaceAccessDenied' })
      await assert.rejects(poll(foreign), { code: 'workspaceAccessDenied' })
      await assert.rejects(poll(foreign, { pin: foreign, enterprise: true }), { code: 'workspaceAccessDenied' })
    })

    await t.test('suspension and removal are fresh on every call even with trusted principal provenance', async () => {
      for (const status of ['suspended', 'removed']) {
        await pool.query('UPDATE mikka_workspace_members SET status=$3 WHERE "workspaceId"=$1 AND "userId"=$2', [selected, owner, status])
        for (const principal of [{}, { pin: selected }, { enterprise: true }]) {
          await assert.rejects(poll(selected, principal), { code: 'workspaceAccessDenied' })
        }
        assert.deepEqual((await poll(personal)).items.map(row => row.runId), [personalRun], 'denial never borrows the selected tenant or hides the owner personal run')
      }
      await pool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [selected, owner])
      assert.deepEqual((await poll(selected, { enterprise: true })).items.map(row => row.runId), [selectedRun])
    })
  } finally {
    await pool.query('DELETE FROM agent_runs WHERE id=ANY($1::uuid[])', [[personalRun, selectedRun]])
    await pool.query('DELETE FROM agents WHERE id=$1', [agent])
    await pool.query('DELETE FROM live_revisions WHERE kind=\'task_run_list\' AND id=$1', [selected])
    await pool.query('DELETE FROM mikka_team_issues WHERE "teamId"=$1', [team])
    await pool.query('DELETE FROM mikka_teams WHERE id=$1', [team])
    await pool.query('DELETE FROM issues WHERE id=ANY($1::uuid[])', [[personalIssue, selectedIssue]])
    await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=ANY($1::uuid[])', [[personal, selected, foreign]])
    await pool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [[personal, selected, foreign]])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[owner, peer]])
  }
})


test('Native workspace choices share only undispatched real SELECTs and retain fresh authority', { skip: !enabled, timeout: 60_000 }, async t => {
  const { pool } = await import('../lib/db')
  const { workspacePool, workspaceDb } = await import('../lib/workspace-db')
  const { COMMIT_EXECUTOR } = await import('../lib/db/commit-effects')
  const { loadWorkspaceContext } = await import('../lib/workspace-access')
  const { withReadBatchContext } = await import('../lib/desktop-rpc/read-batch-context')
  const { withDesktopSession } = await import('../lib/desktop-rpc/session')
  const { createRequestScope, runRequestScope } = await import('../apps/api/src/context')
  const { activityFixtureSession } = await import('./fixtures/activity-runtime.mjs')
  const { tokenWorkspace } = await import('../lib/tokens/principal')
  const { enterprisePrincipal } = await import('../lib/enterprise/principal')
  const { AsyncLocalStorage } = await import('node:async_hooks')
  const { routeScope } = await import('../lib/tracing/labels')
  const owner = 'pending-choices-' + randomUUID(), peer = 'pending-choices-peer-' + randomUUID()
  const personal = randomUUID(), selected = randomUUID(), foreign = randomUUID(), organization = randomUUID()
  type Reader = NonNullable<Parameters<typeof loadWorkspaceContext>[1]>
  const reader = (id = owner) => ({ id, email: id + '@example.invalid', name: 'Synthetic', image: null }) as Reader
  const rawPool = (workspacePool as typeof workspacePool & { [COMMIT_EXECUTOR]: typeof workspacePool })[COMMIT_EXECUTOR]
  assert.ok(rawPool && rawPool !== workspacePool, 'the exact real Workspace Pool is available before any transaction')
  const native = <T>(work: (user: Reader) => Promise<T>) => withActivitySession(owner, () => {
    const session = activityFixtureSession()
    assert.ok(session?.user)
    return runRequestScope(createRequestScope(new Request('http://localhost/api/desktop/rpc')), () =>
      withDesktopSession(session, () => withReadBatchContext(() => work(reader()))))
  }, selected)
  const choices = (values: Read[]) => values.filter(read =>
    read.fields.join(',') === 'id,name,kind,role,organizationId'
    && read.text.includes('from "mikka_workspaces"')
    && read.text.includes('join "mikka_workspace_members"'))
  const policyReads = (values: Read[]) => values.filter(read => read.text.includes('from enterprise_org_policy'))
  const bounded = async <T>(pending: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([pending, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Workspace SELECT barrier did not settle')), 10_000)
      })])
    } finally { if (timer) clearTimeout(timer) }
  }
  // The Pool instance is intercepted, not Client.prototype: commit observation
  // can already have bound a client's query method by the time this test runs.
  const heldFirstRead = async (
    change: (client: import('pg').PoolClient) => Promise<unknown>,
    restore: (client: import('pg').PoolClient) => Promise<unknown>,
  ) => {
    // Keep this checkout leased before the observed Pool.query begins. It
    // cannot be the Pool's concurrent query checkout; no backend PID is inferred.
    const revoker = await rawPool.connect()
    const descriptor = Object.getOwnPropertyDescriptor(rawPool, 'query')
    const query = rawPool.query as (...args: unknown[]) => unknown
    let release!: () => void, entered!: () => void, failed!: (error: unknown) => void, held = false
    const gate = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>((resolve, reject) => { entered = resolve; failed = reject })
    const pending: Promise<unknown>[] = []
    let restoreNeeded = false
    rawPool.query = function (this: typeof rawPool, ...args: unknown[]) {
      const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text ?? ''
      const parameters = Array.isArray(args[1]) ? args[1] : (args[0] as { values?: unknown[] })?.values
      const target = text.startsWith('select "mikka_workspaces"."id", "mikka_workspaces"."name", "mikka_workspaces"."kind", "mikka_workspace_members"."role", "mikka_organization_workspaces"."organizationId" from "mikka_workspaces" inner join "mikka_workspace_members"')
        && parameters?.includes(owner)
      if (held || !target) return Reflect.apply(query, this, args)
      held = true
      try {
        const result = Reflect.apply(query, this, args)
        assert.ok(result instanceof Promise, 'the real Drizzle Pool read uses its Promise API')
        return result.then(async value => { entered(); await gate; return value }, error => { failed(error); throw error })
      } catch (error) { failed(error); throw error }
    } as typeof rawPool.query
    try {
      return await measured(() => native(async user => {
        const first = loadWorkspaceContext(selected, user)
        pending.push(first); void first.catch(() => undefined)
        await bounded(started)
        restoreNeeded = true
        await change(revoker)
        const second = loadWorkspaceContext(selected, user)
        pending.push(second)
        await assert.rejects(bounded(second), { code: 'workspaceAccessDenied' })
        release()
        assert.equal((await bounded(first)).workspace.id, selected, 'the original pre-change SELECT retains its own observation')
        await restore(revoker)
        restoreNeeded = false
        const restored = loadWorkspaceContext(selected, user)
        pending.push(restored)
        assert.equal((await bounded(restored)).workspace.id, selected)
      }))
    } finally {
      release()
      // Even when an assertion or the mutation fails, settle every outstanding
      // caller before restoring the query method or deleting fixture rows.
      await Promise.allSettled(pending)
      try { if (restoreNeeded) await restore(revoker) }
      finally {
        try {
          if (descriptor) Object.defineProperty(rawPool, 'query', descriptor)
          else Reflect.deleteProperty(rawPool, 'query')
        } finally { revoker.release() }
      }
    }
  }
  try {
    const [appDatabase, workspaceDatabase] = await Promise.all([
      pool.query<{ name: string }>('select current_database() as name'),
      rawPool.query<{ name: string }>('select current_database() as name'),
    ])
    assert.equal(workspaceDatabase.rows[0].name, appDatabase.rows[0].name, 'both stores are bound to the same guarded disposable database')
    for (const id of [owner, peer]) await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())', [id, id + '@example.invalid'])
    await seedFixtureWorkspace(pool, owner, 'personal', personal)
    await seedFixtureWorkspace(pool, owner, 'team', selected)
    await seedFixtureWorkspace(pool, peer, 'personal', foreign)
    await pool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,\'member\',\'active\')', [selected, peer, peer + '@example.invalid'])
    await pool.query('INSERT INTO mikka_organizations(id,name,"createdBy") VALUES($1,$2,$3)', [organization, 'Pending choices fixture', owner])
    // Warm only the existing idempotent Personal-share setup, identically in
    // RED and GREEN. The measured path still executes the real workspace reader.
    await withActivitySession(owner, () => loadWorkspaceContext(selected, reader()), selected)
    await withActivitySession(peer, () => loadWorkspaceContext(foreign, reader(peer)), foreign)

    await t.test('five concurrent authenticated readers issue one unchanged membership-and-link SELECT', async sub => {
      const sample = await measured(() => native(user => Promise.all(Array.from({ length: 5 }, () => loadWorkspaceContext(selected, user)))))
      assert.equal(sample.value.length, 5)
      assert.ok(sample.value.every(value => value.workspace.id === selected && value.currentUserId === owner && value.role === 'admin'))
      for (const value of sample.value) assert.deepEqual(value.choices.map(choice => choice.id).sort(), [personal, selected].sort())
      assert.equal(choices(sample.reads).length, 1, 'the old product issues five equivalent fresh SELECTs')
      sub.diagnostic(JSON.stringify({ read: 'pending-native-workspace-choices', readers: 5, workspaceSelects: choices(sample.reads).length,
        selectedWorkspaceRows: sample.value.length, projection: choices(sample.reads)[0].fields }))
      sample.value[0].choices[0].name = 'One consumer changed its local copy'
      assert.notEqual(sample.value[1].choices[0].name, sample.value[0].choices[0].name)
      const later = await measured(() => native(user => loadWorkspaceContext(selected, user)))
      assert.equal(choices(later.reads).length, 1, 'a later HTTP batch always performs a new SELECT')
    })

    await t.test('completed reads never hide same-batch suspension, removal or restoration', async () => {
      const sample = await measured(() => native(async user => {
        assert.equal((await loadWorkspaceContext(selected, user)).workspace.id, selected)
        try {
          for (const status of ['suspended', 'removed']) {
            await rawPool.query('UPDATE mikka_workspace_members SET status=$3 WHERE "workspaceId"=$1 AND "userId"=$2', [selected, owner, status])
            await assert.rejects(loadWorkspaceContext(selected, user), { code: 'workspaceAccessDenied' })
          }
        } finally {
          await rawPool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [selected, owner])
        }
        assert.equal((await loadWorkspaceContext(selected, user)).workspace.id, selected)
      }))
      assert.equal(choices(sample.reads).length, 4)
    })

    await t.test('a membership change is visible while the earlier real SELECT is still unresolved', async () => {
      const sample = await heldFirstRead(
        client => client.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [selected, owner]),
        client => client.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [selected, owner]),
      )
      assert.equal(choices(sample.reads).length, 3, 'initial, revoked and restored callers each use their own SELECT')
    })

    await t.test('a newly attached archived Organization is visible before the old SELECT resolves', async () => {
      await pool.query('INSERT INTO enterprise_org_policy("organizationId","archivedAt") VALUES($1,now())', [organization])
      try {
        const sample = await heldFirstRead(
          client => client.query('INSERT INTO mikka_organization_workspaces("workspaceId","organizationId") VALUES($1,$2)', [selected, organization]),
          client => client.query('DELETE FROM mikka_organization_workspaces WHERE "workspaceId"=$1 AND "organizationId"=$2', [selected, organization]),
        )
        assert.equal(choices(sample.reads).length, 3)
        assert.equal(policyReads(sample.reads).length, 1, 'only the newly linked SELECT enters the real archived-Organization gate')
      } finally {
        await rawPool.query('DELETE FROM mikka_organization_workspaces WHERE "workspaceId"=$1 AND "organizationId"=$2', [selected, organization])
        await pool.query('DELETE FROM enterprise_org_policy WHERE "organizationId"=$1', [organization])
      }
    })

    await t.test('joined readers still execute independent current Organization policy checks', async () => {
      await rawPool.query('INSERT INTO mikka_organization_workspaces("workspaceId","organizationId") VALUES($1,$2)', [selected, organization])
      await pool.query('INSERT INTO enterprise_org_policy("organizationId") VALUES($1)', [organization])
      try {
        const sample = await measured(() => native(async user => {
          const allowed = await Promise.all([loadWorkspaceContext(selected, user), loadWorkspaceContext(selected, user)])
          assert.ok(allowed.every(value => value.workspace.id === selected))
          await pool.query('UPDATE enterprise_org_policy SET "archivedAt"=now() WHERE "organizationId"=$1', [organization])
          const denied = await Promise.allSettled([loadWorkspaceContext(selected, user), loadWorkspaceContext(selected, user)])
          assert.ok(denied.every(value => value.status === 'rejected' && value.reason.code === 'workspaceAccessDenied'))
        }))
        assert.equal(choices(sample.reads).length, 2, 'each parallel pair has one fresh membership/link observation')
        assert.equal(policyReads(sample.reads).length, 4, 'each of the four callers checks Organization policy independently')
      } finally {
        await rawPool.query('DELETE FROM mikka_organization_workspaces WHERE "workspaceId"=$1 AND "organizationId"=$2', [selected, organization])
        await pool.query('DELETE FROM enterprise_org_policy WHERE "organizationId"=$1', [organization])
      }
    })

    await t.test('different authenticated readers, pins, principals, requests and Native sessions cannot join', async () => {
      const pairs = [
        () => [loadWorkspaceContext(selected, reader()), loadWorkspaceContext(selected, reader(peer))],
        () => [loadWorkspaceContext(selected, reader()), loadWorkspaceContext(selected, Object.assign(reader(), { [tokenWorkspace]: selected }))],
        () => [loadWorkspaceContext(selected, reader()), loadWorkspaceContext(personal, reader())],
        () => [loadWorkspaceContext(selected, Object.assign(reader(), { [enterprisePrincipal]: { kind: 'session' as const, sessionId: 'principal-a' } })),
          loadWorkspaceContext(selected, Object.assign(reader(), { [enterprisePrincipal]: { kind: 'session' as const, sessionId: 'principal-b' } }))],
        () => [loadWorkspaceContext(selected, reader()), runRequestScope(createRequestScope(new Request('http://localhost/api/desktop/rpc')), () => loadWorkspaceContext(selected, reader()))],
        () => [loadWorkspaceContext(selected, reader()), withDesktopSession({ session: { id: 'another-native-session' } }, () => loadWorkspaceContext(selected, reader()))],
      ]
      for (const [index, pair] of pairs.entries()) {
        const sample = await measured(() => native(() => Promise.all(pair())))
        assert.equal(sample.value.length, 2)
        assert.equal(choices(sample.reads).length, 2)
        if (index === 0) {
          assert.deepEqual(sample.value.map(value => [value.currentUserId, value.workspace.id, value.role]), [[owner, selected, 'admin'], [peer, selected, 'member']])
          assert.deepEqual(sample.value[0].choices.map(value => value.id).sort(), [personal, selected].sort())
          assert.deepEqual(sample.value[1].choices.map(value => value.id).sort(), [foreign, selected].sort())
        }
        if (index === 1) assert.deepEqual(sample.value[1].choices.map(value => value.id), [selected], 'the pinned reader keeps its original filtered choices')
      }
      await native(async user => {
        await assert.rejects(loadWorkspaceContext(foreign, user), { code: 'workspaceAccessDenied' })
        await assert.rejects(loadWorkspaceContext(personal, Object.assign(reader(), { [tokenWorkspace]: selected })), { code: 'workspaceAccessDenied' })
      })
    })

    await t.test('top-level Workspace transactions and nested savepoints bypass the pending queue', async () => {
      const sample = await measured(() => native(user => workspaceDb.transaction(async () => {
        const outer = await Promise.all([loadWorkspaceContext(selected, user), loadWorkspaceContext(selected, user)])
        assert.ok(outer.every(value => value.workspace.id === selected))
        await workspaceDb.transaction(async () => {
          const inner = await Promise.all([loadWorkspaceContext(selected, user), loadWorkspaceContext(selected, user)])
          assert.ok(inner.every(value => value.workspace.id === selected))
        })
      })))
      assert.equal(choices(sample.reads).length, 4, 'no transaction or savepoint query is coalesced')
    })

    await t.test('foreground-only scope cannot survive as deferred, expired or non-Native work', async () => {
      for (const route of ['after:pending-choices', 'cron:pending-choices', 'workflow:pending-choices']) {
        const sample = await measured(() => native(user => routeScope.run(route, () => Promise.all([
          loadWorkspaceContext(selected, user), loadWorkspaceContext(selected, user),
        ]))))
        assert.equal(choices(sample.reads).length, 2)
      }
      let later!: () => Promise<Awaited<ReturnType<typeof loadWorkspaceContext>>[]>
      await native(async user => {
        later = AsyncLocalStorage.bind(() => Promise.all([loadWorkspaceContext(selected, user), loadWorkspaceContext(selected, user)]))
      })
      assert.equal(choices((await measured(later)).reads).length, 2, 'retained ALS cannot reactivate a closed queue')
      const ordinary = await measured(() => withActivitySession(owner, () => withReadBatchContext(() => Promise.all([
        loadWorkspaceContext(selected, reader()), loadWorkspaceContext(selected, reader()),
      ])), selected))
      assert.equal(choices(ordinary.reads).length, 2, 'a non-Native scope does not opt into the queue')
    })
  } finally {
    await rawPool.query('DELETE FROM mikka_organization_workspaces WHERE "workspaceId"=$1 AND "organizationId"=$2', [selected, organization])
    await pool.query('DELETE FROM enterprise_org_policy WHERE "organizationId"=$1', [organization])
    await rawPool.query('DELETE FROM mikka_organizations WHERE id=$1', [organization])
    await rawPool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=ANY($1::uuid[])', [[personal, selected, foreign]])
    await rawPool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])', [[personal, selected, foreign]])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[owner, peer]])
  }
})
