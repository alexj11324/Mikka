import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Pool } from 'pg'

// Explicitly refuse business databases. This executes the real server action and real SQL.
const target = new URL(process.env.E2E_DATABASE_URL ?? 'http://invalid')
if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) || !target.pathname.endsWith('_e2e') || process.env.MIKKA_DATABASE_URL !== target.href || process.env.DATABASE_URL !== target.href) throw new Error('Thread integration requires the same isolated loopback *_e2e database for both stores')
const pool = new Pool({ connectionString: target.href, max: 1 })
const owner = randomUUID(), viewer = randomUUID(), outsider = randomUUID(), removed = randomUUID()
const issue = randomUUID(), other = randomUUID(), workspace = randomUUID(), team = randomUUID(), agent = randomUUID()
const run = randomUUID(), removedRun = randomUUID(), otherRun = randomUUID()
const excessRuns = Array.from({ length: 21 }, () => randomUUID())
test('real actions keep thread content with its owner; current members see only whose threads exist and their status', async () => {
  const { listIssueThreads, getIssueThread, sendIssueThreadMessage } = await import('../app/actions/agents')
  const { actAs } = await import('../lib/acting-user')
  const { requestRunStop } = await import('../lib/agent-runs')
  try {
    for (const id of [owner, viewer, outsider, removed]) await pool.query('INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES ($1,$2,$3,false,now(),now())', [id, id === viewer ? 'Lin' : 'Isolated run test', `${id}@example.com`])
    for (const id of [issue, other]) await pool.query(`INSERT INTO issues (id,"userId",title,content,status,priority) VALUES ($1,$2,$3,'{"type":"doc","content":[]}','todo','normal')`, [id, owner, 'Isolated thread'])
    await pool.query('INSERT INTO issue_members ("issueId","userId","memberId") VALUES ($1,$2,$3),($1,$2,$4)', [issue, owner, viewer, removed])
    await pool.query('INSERT INTO agents (id,"userId",harness,name,instructions) VALUES ($1,$2,$3,$4,$5)', [agent,owner,'codex','Mikka Backend','PRIVATE INSTRUCTIONS'])
    for (const [id, userId, issueId, status] of [[run,owner,issue,'running'],[removedRun,removed,issue,'succeeded'],[otherRun,owner,other,'succeeded']]) await pool.query('INSERT INTO agent_runs (id,"userId","issueId","agentId",status,prompt,report,error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id,userId,issueId,agent,status,'Route group replies',JSON.stringify({summary:'Routed'}),null])
    await pool.query('INSERT INTO run_chunks (id,"runId",seq,chunk) VALUES ($1,$2,1,$3)', [randomUUID(),run,JSON.stringify({type:'text-delta',id:'a',delta:'Reproduced it'})])
    await assert.rejects(actAs(outsider, () => listIssueThreads(issue)))
    await assert.rejects(actAs(viewer, () => listIssueThreads(other)))
    await assert.rejects(actAs(viewer, () => listIssueThreads('invalid')))

    // A personal issue is the owner's alone (R-26): a legacy invitation grants nothing.
    await assert.rejects(actAs(viewer, () => listIssueThreads(issue)))
    await assert.rejects(actAs(viewer, () => getIssueThread(issue, run)))
    await assert.rejects(actAs(viewer, () => sendIssueThreadMessage({ issueId: issue, runId: run, text: 'Must not reach the agent' })))
    const own = await actAs(owner, () => getIssueThread(issue, run))
    assert.equal(own.thread.detail?.name, 'Route group replies')
    await assert.rejects(actAs(owner, () => getIssueThread(other, run)))

    // Workspace collaboration exposes thread metadata; contents remain owner-only.
    await pool.query('UPDATE issues SET scope=$2 WHERE id=$1', [issue, 'workspace'])
    await pool.query('INSERT INTO mikka_workspaces (id,"userId",name) VALUES ($1,$2,$3)',[workspace,owner,'Isolated run workspace'])
    await pool.query('INSERT INTO mikka_teams (id,"workspaceId","userId",name,identifier) VALUES ($1,$2,$3,$4,$5)',[team,workspace,owner,'Run test','RUNTEST'])
    await pool.query('INSERT INTO mikka_team_issues ("issueId","teamId","workspaceId","userId") VALUES ($1,$2,$3,$4)',[issue,team,workspace,owner])
    for (const id of [owner,viewer,removed]) await pool.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$3,$4,$5,$6)',[workspace,id,'Member',`${id}@example.com`,'member','active'])
    // A workspace issue: teammates see whose threads exist and their status, never their content.
    const listed = await actAs(viewer, () => listIssueThreads(issue))
    assert.deepEqual(listed.map(row => [row.detail, row.ownerName, row.ownedByCurrentUser]).sort(), [[null, 'Isolated run test', false], [null, 'Isolated run test', false]])
    assert.ok(!/Route|Mikka Backend|Routed|PRIVATE/.test(JSON.stringify(listed)))
    await assert.rejects(actAs(viewer, () => getIssueThread(issue, run)))
    await assert.rejects(actAs(viewer, () => sendIssueThreadMessage({ issueId: issue, runId: run, text: 'Check the fallback' })))
    // The owner still reads and talks in their own thread.
    await actAs(owner, () => sendIssueThreadMessage({ issueId: issue, runId: run, text: 'Check the fallback' }))
    const after = await actAs(owner, () => getIssueThread(issue, run))
    assert.equal(after.chunks.length, 1)
    assert.deepEqual(after.messages.map(message => [message.text, message.mine]), [['Check the fallback', true]])
    await assert.rejects(actAs(owner, () => sendIssueThreadMessage({ issueId: issue, runId: otherRun, text: 'Wrong issue' })))
    await assert.rejects(actAs(owner, () => sendIssueThreadMessage({ issueId: issue, runId: run, text: '   ' })))
    // Stopping stays with the owner.
    await assert.rejects(requestRunStop(viewer, run), { code: 'runNotFound' })
    const {rows:[unchanged]} = await pool.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id=$1',[run])
    assert.equal(unchanged.stopRequestedAt,null)
    // Suspension ends access while retaining the stale membership row for inspection.
    await pool.query('UPDATE mikka_workspace_members SET status=$3 WHERE "workspaceId"=$1 AND "userId"=$2',[workspace,removed,'suspended'])
    assert.deepEqual((await actAs(viewer,()=>listIssueThreads(issue))).map(row=>row.id),[run])
    await assert.rejects(actAs(removed,()=>listIssueThreads(issue)))
    await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`,[workspace,viewer])
    await assert.rejects(actAs(viewer,()=>listIssueThreads(issue)))
    await assert.rejects(actAs(viewer,()=>getIssueThread(issue, run)))
    for (const id of excessRuns) await pool.query('INSERT INTO agent_runs (id,"userId","issueId","agentId",status) VALUES ($1,$2,$3,$4,$5)', [id,owner,issue,agent,'succeeded'])
    // Ownership permits reading a finished thread, but cannot reopen its message channel.
    const finishedRun = excessRuns[0]
    const finished = await actAs(owner, () => getIssueThread(issue, finishedRun))
    assert.equal(finished.thread.ownedByCurrentUser, true)
    const messagesBefore = (await pool.query('SELECT * FROM run_messages WHERE "runId"=$1 ORDER BY id', [finishedRun])).rows
    await assert.rejects(actAs(owner, () => sendIssueThreadMessage({ issueId: issue, runId: finishedRun, text: 'Must not reopen a finished thread' })), { code: 'runNotFound' })
    assert.deepEqual((await pool.query('SELECT * FROM run_messages WHERE "runId"=$1 ORDER BY id', [finishedRun])).rows, messagesBefore)
    const bounded = await actAs(owner, () => listIssueThreads(issue))
    assert.equal(bounded.length, 20)
    assert.ok(bounded.every(row => row.ownedByCurrentUser && row.id !== otherRun && row.id !== removedRun))
    await requestRunStop(owner, run)
    const { rows: [stopped] } = await pool.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id=$1', [run])
    assert.ok(stopped.stopRequestedAt, 'the owner can actually stop the same run')
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM mikka_workspace_members WHERE "workspaceId"=$1', [workspace])).rows[0].n, 3)
  } finally {
    // Keep all uniquely identified synthetic rows, including on assertion failure.
    await pool.end()
  }
})
