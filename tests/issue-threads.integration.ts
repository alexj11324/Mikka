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
test('real actions share threads on workspace issues only, with current members, and keep run controls with the owner', async () => {
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

    // A personal issue: a collaborator sees that the owner's thread exists, nothing more.
    const personal = await actAs(viewer, () => listIssueThreads(issue))
    assert.equal(personal.length, 2)
    assert.ok(personal.every(row => row.id !== otherRun && !row.ownedByCurrentUser && row.detail === null))
    assert.ok(!JSON.stringify(personal).includes('Route') && !JSON.stringify(personal).includes('Mikka Backend'))
    await assert.rejects(actAs(viewer, () => getIssueThread(issue, run)))
    await assert.rejects(actAs(viewer, () => sendIssueThreadMessage({ issueId: issue, runId: run, text: 'Must not reach the agent' })))
    const own = await actAs(owner, () => getIssueThread(issue, run))
    assert.equal(own.thread.detail?.name, 'Route group replies')
    await assert.rejects(actAs(owner, () => getIssueThread(other, run)))

    // A workspace issue: current members read and join every collaborator's thread.
    await pool.query('INSERT INTO mikka_workspaces (id,"userId",name) VALUES ($1,$2,$3)',[workspace,owner,'Isolated run workspace'])
    await pool.query('INSERT INTO mikka_teams (id,"workspaceId","userId",name,identifier) VALUES ($1,$2,$3,$4,$5)',[team,workspace,owner,'Run test','RUNTEST'])
    await pool.query('INSERT INTO mikka_team_issues ("issueId","teamId","workspaceId","userId") VALUES ($1,$2,$3,$4)',[issue,team,workspace,owner])
    for (const id of [owner,viewer,removed]) await pool.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$3,$4,$5,$6)',[workspace,id,'Member',`${id}@example.com`,'member','active'])
    const shared = await actAs(viewer, () => listIssueThreads(issue))
    assert.deepEqual(shared.map(row => row.detail?.agentName), ['Mikka Backend', 'Mikka Backend'])
    const thread = await actAs(viewer, () => getIssueThread(issue, run))
    assert.equal(thread.chunks.length, 1)
    assert.ok(!JSON.stringify(thread).includes('PRIVATE INSTRUCTIONS'))
    await actAs(viewer, () => sendIssueThreadMessage({ issueId: issue, runId: run, text: 'Check the fallback' }))
    const after = await actAs(owner, () => getIssueThread(issue, run))
    assert.deepEqual(after.messages.map(message => [message.text, message.author, message.mine]), [['Check the fallback', 'Lin', false]])
    await assert.rejects(actAs(viewer, () => sendIssueThreadMessage({ issueId: issue, runId: removedRun, text: 'Finished threads take no messages' })))
    await assert.rejects(actAs(viewer, () => sendIssueThreadMessage({ issueId: issue, runId: run, text: '   ' })))
    // Stopping stays with the owner.
    await requestRunStop(viewer, run)
    const {rows:[unchanged]} = await pool.query('SELECT "stopRequestedAt" FROM agent_runs WHERE id=$1',[run])
    assert.equal(unchanged.stopRequestedAt,null)
    // Suspension or removal from the workspace ends access, even with stale direct membership.
    await pool.query('UPDATE mikka_workspace_members SET status=$3 WHERE "workspaceId"=$1 AND "userId"=$2',[workspace,removed,'suspended'])
    assert.deepEqual((await actAs(viewer,()=>listIssueThreads(issue))).map(row=>row.id),[run])
    await assert.rejects(actAs(removed,()=>listIssueThreads(issue)))
    await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2',[workspace,viewer])
    await assert.rejects(actAs(viewer,()=>listIssueThreads(issue)))
    await assert.rejects(actAs(viewer,()=>getIssueThread(issue, run)))
    for (const id of excessRuns) await pool.query('INSERT INTO agent_runs (id,"userId","issueId","agentId",status) VALUES ($1,$2,$3,$4,$5)', [id,owner,issue,agent,'succeeded'])
    const bounded = await actAs(owner, () => listIssueThreads(issue))
    assert.equal(bounded.length, 20)
    assert.ok(bounded.every(row => row.ownedByCurrentUser && row.id !== otherRun && row.id !== removedRun))
  } finally {
    await pool.query('DELETE FROM run_messages WHERE "runId"=ANY($1::uuid[])',[[run,removedRun,otherRun]])
    await pool.query('DELETE FROM run_chunks WHERE "runId"=ANY($1::uuid[])',[[run,removedRun,otherRun,...excessRuns]])
    await pool.query('DELETE FROM agent_runs WHERE id=ANY($1::uuid[])',[[run,removedRun,otherRun,...excessRuns]])
    await pool.query('DELETE FROM agents WHERE id=$1',[agent])
    await pool.query('DELETE FROM issue_members WHERE "issueId"=ANY($1::uuid[])',[[issue,other]])
    await pool.query('DELETE FROM mikka_team_issues WHERE "issueId"=$1',[issue])
    await pool.query('DELETE FROM mikka_teams WHERE id=$1',[team])
    await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1',[workspace])
    await pool.query('DELETE FROM mikka_workspaces WHERE id=$1',[workspace])
    await pool.query('DELETE FROM issues WHERE id=ANY($1::uuid[])',[[issue,other]])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])',[[owner,viewer,outsider,removed]])
    await pool.end()
  }
})
