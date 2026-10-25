import { createHash, randomUUID } from 'node:crypto'
import { test, expect } from '@playwright/test'
import { Pool } from 'pg'
import { request as httpRequest } from 'node:http'

// This suite writes only synthetic fixtures in the existing isolated CI database.
// No deletion/cleanup: preserve rows for readback and failure evidence.
test('worker MCP rechecks current issue authority after queueing and revocation', async ({ request }, testInfo) => {
  const target = new URL(process.env.E2E_DATABASE_URL!)
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(target.hostname)
  expect(target.pathname).toBe('/mikka_e2e')
  const pool = new Pool({ connectionString: target.toString() })
  const owner = `authz-owner-${randomUUID()}`, member = `authz-member-${randomUUID()}`
  const otherOwner = `authz-owner-b-${randomUUID()}`, otherMember = `authz-member-b-${randomUUID()}`
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
  async function call(token: string, check: string, expected: number, tool = 'report', extra: Record<string, string> = {}) {
    const response = await request.post('/mikka/api/mcp', {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
      data: { jsonrpc:'2.0', id:++sequence, method:'tools/call', params:{name:tool,arguments:tool === 'ask' ? {question:'Synthetic authorization question'} : tool === 'blocked' ? {reason:'Synthetic authorization block'} : {text:'Synthetic authorization regression',...extra}} },
    })
    evidence.push({check,status:response.status()})
    expect.soft(response.status(), check).toBe(expected)
    if (expected === 200 && response.status() === 200) expect.soft(await response.text()).toContain(tool === 'ask' ? 'Asked.' : tool === 'blocked' ? 'Noted.' : 'Reported.')
  }
  async function events(run: string) {
    return Number((await pool.query('select count(*) from coordinator_events where "runId"=$1',[run])).rows[0].count)
  }
  try {
    for (const [workspace,team,workspaceOwner] of [[workspaceA,teamA,owner],[workspaceB,teamB,otherOwner]]) {
      await pool.query('insert into mikka_workspaces(id,"userId",name) values($1,$2,$3)',[workspace,workspaceOwner,'Authorization fixture'])
      await pool.query('insert into mikka_teams(id,"workspaceId","userId",name,identifier) values($1,$2,$3,$4,$5)',[team,workspace,workspaceOwner,'Fixture','AUTHZ'])
      await pool.query('insert into mikka_workspace_members("workspaceId","userId",name,email,role) values($1,$2,$3,$4,$5)',[workspace,workspaceOwner,'Fixture owner',`${workspaceOwner}@example.invalid`,'admin'])
    }
    await pool.query('insert into mikka_workspace_members("workspaceId","userId",name,email,role) values($1,$2,$3,$4,$5)',[workspaceA,member,'Fixture member',`${member}@example.invalid`,'member'])
    for (const userId of [otherMember,owner]) await pool.query('insert into mikka_workspace_members("workspaceId","userId",name,email,role) values($1,$2,$3,$4,$5)',[workspaceB,userId,'Fixture member',`${userId}@example.invalid`,'member'])
    for (const [issue,workspace,team] of [[issueA,workspaceA,teamA],[issueB,workspaceB,teamB],[personal,null,null]]) {
      await pool.query('insert into issues(id,"userId",title,content,status,priority,scope) values($1,$2,$3,$4,$5,$6,$7)',[issue,workspace === workspaceB ? otherOwner : owner,'Synthetic authorization fixture',{type:'doc',content:[]},'todo','normal',workspace?'workspace':'personal'])
      if(workspace) await pool.query('insert into mikka_team_issues("issueId","teamId","workspaceId","userId") values($1,$2,$3,$4)',[issue,team,workspace,workspace === workspaceB ? otherOwner : owner])
    }
    const admin = await runFor(owner,issueA), active = await runFor(member,issueA), queued = await runFor(member,issueA,'queued')
    await call(admin.token,'workspace owner/admin',200)
    await call(active.token,'active workspace member',200)
    await call(active.token,'active member ask',200,'ask')
    await call(active.token,'active member blocked',200,'blocked')
    expect(await events(active.run)).toBe(3)
    const independent = await runFor(otherMember,issueB), secondAdmin = await runFor(otherOwner,issueB), multiWorkspace = await runFor(owner,issueB)
    await call(secondAdmin.token,'independent workspace B owner',200)
    await call(independent.token,'independent workspace B member',200)
    await call(multiWorkspace.token,'same user active in both workspaces',200)
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
    await call(independent.token,'workspace B remains unaffected by A revocation',200)
    expect(await events(independent.run)).toBe(2)
    await pool.query('update agent_runs set "stopRequestedAt"=now() where id=$1',[admin.run])
    await call(admin.token,'stop request rejects live token',401)
    await pool.query('update run_tokens set "revokedAt"=now() where "runId"=$1',[privateRun.run])
    await call(privateRun.token,'explicit token revocation',401)
    const expired = await runFor(owner,personal), ended = await runFor(owner,personal,'succeeded')
    await pool.query('update run_tokens set "expiresAt"=now()-interval \'1 second\' where "runId"=$1',[expired.run])
    await call(expired.token,'expired token',401)
    await call(ended.token,'terminal run',401)
    // A worker bearer cannot select a different task/run by injecting IDs.
    await call(secondAdmin.token,'original token ignores forged workspace/run/issue selectors',200,'report',{workspaceId:workspaceA,issueId:issueA,runId:active.run})
    expect(await events(active.run)).toBe(3)
    expect(await events(secondAdmin.run)).toBe(2)

    // Real HTTP authentication completes while the request body is withheld.
    // Observe the final auth query in PG, revoke, then permit tool execution.
    const origin = new URL(process.env.E2E_BASE_URL ?? 'http://localhost:3100')
    expect(['localhost','127.0.0.1','[::1]']).toContain(origin.hostname)
    for (const status of ['queued','running']) {
      await pool.query('update mikka_workspace_members set status=$1 where "workspaceId"=$2 and "userId"=$3',['active',workspaceA,member])
      const delayed = await runFor(member,issueA,status)
      const body = JSON.stringify({jsonrpc:'2.0',id:++sequence,method:'tools/call',params:{name:'report',arguments:{text:'Delayed body fixture'}}})
      const marker = (await pool.query('select clock_timestamp()::text as at')).rows[0].at
      let send!: ReturnType<typeof httpRequest>
      const response = new Promise<{status:number;body:string}>((resolve,reject) => {
        send = httpRequest(new URL('/mikka/api/mcp',origin),{method:'POST',headers:{authorization:`Bearer ${delayed.token}`,accept:'application/json, text/event-stream','content-type':'application/json','content-length':Buffer.byteLength(body)}},res => {
          let text = ''; res.on('data',chunk => { text += chunk }); res.on('end',() => resolve({status:res.statusCode!,body:text}))
        })
        send.on('error',reject); send.setTimeout(15000,() => send.destroy(new Error('Delayed authorization test timed out')))
      })
      void response.catch(() => {})
      try {
        send.write(body.slice(0,1)); send.flushHeaders()
        await expect.poll(async () => Number((await pool.query(`select count(*) from pg_stat_activity where pid <> pg_backend_pid() and query_start > $1::timestamptz and state='idle' and query like 'select %"issues"%' and query like '%left join "issue_members"%'`,[marker])).rows[0].count),{timeout:10000}).toBeGreaterThan(0)
        await pool.query('update mikka_workspace_members set status=$1 where "workspaceId"=$2 and "userId"=$3',['suspended',workspaceA,member])
        send.end(body.slice(1))
        const result = await response
        expect(result.status).toBe(200) // MCP tool error: middleware already accepted this request.
        expect(result.body).toContain('MCP run authorization is no longer valid')
        expect(await events(delayed.run)).toBe(0)
        evidence.push({check:`${status}: revoke after HTTP auth before tool body`,status:result.status})
      } finally { send.destroy(); await response.catch(() => {}) }
    }

    // Freeze an actual INSERT after all checks. A concurrent revocation must
    // wait for that authorized event's commit, then deny every later request.
    // Unique triggers affect only their own synthetic run; no DROP/DELETE.
    for (const mode of ['membership','stop','token']) {
      await pool.query('update mikka_workspace_members set status=$1 where "workspaceId"=$2 and "userId"=$3',['active',workspaceA,member])
      const fenced = await runFor(member,issueA)
      const key = randomUUID(), name = `authz_gate_${key.replaceAll('-','')}`
      await pool.query(`create function ${name}() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(hashtextextended('${key}',0)); return new; end $$`)
      await pool.query(`create trigger ${name} before insert on coordinator_events for each row when (new."runId"='${fenced.run}') execute function ${name}()`)
      const blocker = await pool.connect(), revoker = await pool.connect()
      let pending: Promise<unknown> | undefined, revoke: Promise<unknown> | undefined
      try {
        const blockerPid = (await blocker.query('select pg_backend_pid() as pid')).rows[0].pid
        const revokerPid = (await revoker.query('select pg_backend_pid() as pid')).rows[0].pid
        await blocker.query('select pg_advisory_lock(hashtextextended($1,0))',[key])
        pending = call(fenced.token,`${mode}: authorized in-flight event commits first`,200)
        await expect.poll(async () => Number((await pool.query('select count(*) from pg_stat_activity where $1 = any(pg_blocking_pids(pid))',[blockerPid])).rows[0].count),{timeout:10000}).toBeGreaterThan(0)
        revoke = mode === 'membership'
          ? revoker.query('update mikka_workspace_members set status=$1 where "workspaceId"=$2 and "userId"=$3',['suspended',workspaceA,member])
          : mode === 'stop'
            ? revoker.query('update agent_runs set "stopRequestedAt"=now() where id=$1',[fenced.run])
            : revoker.query('update run_tokens set "revokedAt"=now() where "runId"=$1',[fenced.run])
        void revoke.catch(() => {})
        await expect.poll(async () => (await pool.query('select cardinality(pg_blocking_pids($1)) as count',[revokerPid])).rows[0].count,{timeout:3000}).toBeGreaterThan(0)
        await blocker.query('select pg_advisory_unlock(hashtextextended($1,0))',[key])
        await pending; await revoke
        expect(await events(fenced.run)).toBe(1)
        await call(fenced.token,`${mode}: committed revoke rejects next event`,401)
        expect(await events(fenced.run)).toBe(1)
      } finally {
        await blocker.query('select pg_advisory_unlock(hashtextextended($1,0))',[key])
        await Promise.allSettled([pending,revoke].filter(Boolean))
        blocker.release(); revoker.release()
      }
    }
    await Promise.all(Array.from({length:6},(_,index) => call(independent.token,`bounded pools concurrent request ${index}`,200)))
    expect(await events(independent.run)).toBe(8)
    await testInfo.attach('worker-authorization-evidence',{body:JSON.stringify({sha:process.env.GITHUB_SHA,environment:'CI isolated PG17 + built Next HTTP',workspaceA,workspaceB,evidence}),contentType:'application/json'})
  } finally { await pool.end() }
})
