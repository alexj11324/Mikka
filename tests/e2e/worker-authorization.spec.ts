import { createHash, randomUUID } from 'node:crypto'
import { test, expect } from '@playwright/test'
import { Pool } from 'pg'

// This suite writes only synthetic fixtures in the existing isolated CI database.
// No deletion/cleanup: preserve rows for readback and failure evidence.
test('worker MCP rechecks current issue authority after queueing and revocation', async ({ request }, testInfo) => {
  const target = new URL(process.env.E2E_DATABASE_URL!)
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(target.hostname)
  expect(target.pathname).toBe('/mikka_e2e')
  const pool = new Pool({ connectionString: target.toString() })
  const owner = `authz-owner-${randomUUID()}`, member = `authz-member-${randomUUID()}`
  const workspaceA = randomUUID(), workspaceB = randomUUID(), teamA = randomUUID(), teamB = randomUUID()
  const issueA = randomUUID(), issueB = randomUUID(), personal = randomUUID()
  const evidence: { check: string; status: number }[] = []
  let sequence = 0
  async function runFor(userId: string, issueId: string | null, status = 'running') {
    const agent = randomUUID(), run = randomUUID(), token = `mkw_${randomUUID()}`
    await pool.query('insert into agents(id,"userId",harness,name) values($1,$2,$3,$4)', [agent,userId,'codex',`fixture-${agent}`])
    await pool.query('insert into agent_runs(id,"userId","issueId","agentId",status) values($1,$2,$3,$4,$5)', [run,userId,issueId,agent,status])
    await pool.query('insert into run_tokens(id,"runId","userId","tokenHash","expiresAt") values($1,$2,$3,$4,now()+interval \'1 hour\')', [randomUUID(),run,userId,createHash('sha256').update(token).digest('hex')])
    return { run, token }
  }
  async function call(token: string, check: string, expected: number, tool = 'report') {
    const response = await request.post('/mikka/api/mcp', {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
      data: { jsonrpc:'2.0', id:++sequence, method:'tools/call', params:{name:tool,arguments:tool === 'ask' ? {question:'Synthetic authorization question'} : tool === 'blocked' ? {reason:'Synthetic authorization block'} : {text:'Synthetic authorization regression'}} },
    })
    evidence.push({check,status:response.status()})
    expect.soft(response.status(), check).toBe(expected)
    if (expected === 200 && response.status() === 200) expect.soft(await response.text()).toContain(tool === 'ask' ? 'Asked.' : tool === 'blocked' ? 'Noted.' : 'Reported.')
  }
  async function events(run: string) {
    return Number((await pool.query('select count(*) from coordinator_events where "runId"=$1',[run])).rows[0].count)
  }
  try {
    for (const [workspace,team] of [[workspaceA,teamA],[workspaceB,teamB]]) {
      await pool.query('insert into mikka_workspaces(id,"userId",name) values($1,$2,$3)',[workspace,owner,'Authorization fixture'])
      await pool.query('insert into mikka_teams(id,"workspaceId","userId",name,identifier) values($1,$2,$3,$4,$5)',[team,workspace,owner,'Fixture','AUTHZ'])
      await pool.query('insert into mikka_workspace_members("workspaceId","userId",name,email,role) values($1,$2,$3,$4,$5)',[workspace,owner,'Fixture owner',`${owner}@example.invalid`,'admin'])
    }
    await pool.query('insert into mikka_workspace_members("workspaceId","userId",name,email,role) values($1,$2,$3,$4,$5)',[workspaceA,member,'Fixture member',`${member}@example.invalid`,'member'])
    for (const [issue,workspace,team] of [[issueA,workspaceA,teamA],[issueB,workspaceB,teamB],[personal,null,null]]) {
      await pool.query('insert into issues(id,"userId",title,content,status,priority,scope) values($1,$2,$3,$4,$5,$6,$7)',[issue,owner,'Synthetic authorization fixture',{type:'doc',content:[]},'todo','normal',workspace?'workspace':'personal'])
      if(workspace) await pool.query('insert into mikka_team_issues("issueId","teamId","workspaceId","userId") values($1,$2,$3,$4)',[issue,team,workspace,owner])
    }
    const admin = await runFor(owner,issueA), active = await runFor(member,issueA), queued = await runFor(member,issueA,'queued')
    await call(admin.token,'workspace owner/admin',200)
    await call(active.token,'active workspace member',200)
    await call(active.token,'active member ask',200,'ask')
    await call(active.token,'active member blocked',200,'blocked')
    expect(await events(active.run)).toBe(3)
    const foreign = await runFor(member,issueB)
    await call(foreign.token,'member of A cannot act on B',401)
    expect.soft(await events(foreign.run)).toBe(0)
    const privateRun = await runFor(owner,personal)
    await call(privateRun.token,'personal owner without workspace link',200)
    const noIssue = await runFor(owner,null)
    await call(noIssue.token,'orphan run fails closed',401)
    await pool.query('update mikka_workspace_members set status=$1 where "workspaceId"=$2 and "userId"=$3',['suspended',workspaceA,member])
    await call(active.token,'running member revoked before next request',401)
    await call(active.token,'revoked member ask',401,'ask')
    await call(active.token,'revoked member blocked',401,'blocked')
    await call(queued.token,'queued member revoked before tool execution',401)
    expect.soft(await events(active.run)).toBe(3)
    expect.soft(await events(queued.run)).toBe(0)
    await call(admin.token,'other active owner remains allowed',200)
    await pool.query('update agent_runs set "stopRequestedAt"=now() where id=$1',[admin.run])
    await call(admin.token,'stop request rejects live token',401)
    await pool.query('update run_tokens set "revokedAt"=now() where "runId"=$1',[privateRun.run])
    await call(privateRun.token,'explicit token revocation',401)
    const expired = await runFor(owner,personal), ended = await runFor(owner,personal,'succeeded')
    await pool.query('update run_tokens set "expiresAt"=now()-interval \'1 second\' where "runId"=$1',[expired.run])
    await call(expired.token,'expired token',401)
    await call(ended.token,'terminal run',401)
    await testInfo.attach('worker-authorization-evidence',{body:JSON.stringify({sha:process.env.GITHUB_SHA,environment:'CI isolated PG17 + built Next HTTP',workspaceA,workspaceB,evidence}),contentType:'application/json'})
  } finally { await pool.end() }
})
