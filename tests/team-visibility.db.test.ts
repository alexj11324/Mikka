import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

// No business/local database fallback, including when REQUIRE_DB is unset.
const url = process.env.E2E_DATABASE_URL
const authorized = process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true' && url
if (url && (!authorized || new URL(url).hostname !== '127.0.0.1' || new URL(url).pathname !== '/mikka_e2e')) throw new Error('Visibility DB tests require GitHub CI ephemeral mikka_e2e')
if (process.env.REQUIRE_DB === '1' && !authorized) throw new Error('Visibility database tests cannot skip in required CI')

test('real API/core visibility: owner, teammate, outsider, scope flip and suspension', { skip: !authorized }, async () => {
  const { Pool } = await import('pg')
  const { drizzle } = await import('drizzle-orm/node-postgres')
  const pool = new Pool({ connectionString: url, max: 2 })
  const { issueForUser } = await import('../lib/issue-access')
  const { issueVisibility } = await import('../lib/issue-visibility')
  const { db, pool: appPool, createRequestDatabaseScope } = await import('../lib/db')
  const { issues } = await import('../lib/db/schema')
  const { readRun, visibleRuns, addRunMessage, requestRunStop } = await import('../lib/agent-runs')
  const tools = await import('../lib/mcp/tools')
  const actions = await import('../lib/mcp/actions')
  const { citationSources } = await import('../lib/coordinator/store')
  const { issuePropertyChoices } = await import('../lib/issue-property-choices')
  const owner = `visibility-owner-${randomUUID()}`, member = `visibility-member-${randomUUID()}`, foreign = `visibility-foreign-${randomUUID()}`
  const workspace = randomUUID(), otherWorkspace = randomUUID(), team = randomUUID(), otherTeam = randomUUID()
  const shared = randomUUID(), personal = randomUUID(), foreignIssue = randomUUID(), unlinked = randomUUID()
  const agent = randomUUID(), ownAgent = randomUUID(), sharedRun = randomUUID(), privateRun = randomUUID(), orphanRun = randomUUID(), foreignRun = randomUUID()
  const doc = (label: string) => JSON.stringify({ type: 'doc', attrs: { mikka: { number: 1, labels: [{ name: label, color: 'blue' }] } }, content: [] })
  try {
    for (const [id, name] of [[owner, 'Owner'], [member, 'Member'], [foreign, 'Foreign']]) await pool.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$2,$3,true,now(),now())', [id, name, `${id}@example.invalid`])
    for (const [id, user] of [[workspace, owner], [otherWorkspace, foreign]]) await pool.query('insert into mikka_workspaces (id,"userId",name) values ($1,$2,$3)', [id,user,`Visibility ${id}`])
    for (const [w,u] of [[workspace,owner],[workspace,member],[otherWorkspace,foreign]]) await pool.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,$2,$3,\'member\',\'active\')', [w,u,`${u}@example.invalid`])
    for (const [id,w,u] of [[team,workspace,owner],[otherTeam,otherWorkspace,foreign]]) await pool.query('insert into mikka_teams (id,"workspaceId","userId",name,identifier) values ($1,$2,$3,\'Visibility\',\'VIS\')', [id,w,u])
    for (const [id,u,scope,label] of [[shared,owner,'workspace','shared-label'],[personal,owner,'personal','secret-label'],[foreignIssue,foreign,'workspace','foreign-label'],[unlinked,owner,'workspace','invite-label']]) {
      await pool.query('insert into issues (id,"userId",title,content,status,priority,scope) values ($1,$2,$3,$4,\'doing\',\'normal\',$5)', [id,u,id,doc(label),scope])
      await pool.query('insert into issue_members ("issueId","userId","memberId") values ($1,$2,$3)', [id,u,member])
    }
    // Stale invitations cannot bypass a workspace link; personal scope wins
    // even over both a team link and an explicit legacy invitation.
    for (const id of [shared,personal]) await pool.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)', [id,team,workspace,owner])
    await pool.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)', [foreignIssue,otherTeam,otherWorkspace,foreign])
    for (const [id,u] of [[agent,owner],[ownAgent,member]]) await pool.query('insert into agents (id,"userId",harness,name,instructions) values ($1,$2,\'codex\',$3,\'secret-standing-instructions\')', [id,u,`private-agent-${id}`])
    for (const [id,issue,u,a] of [[sharedRun,shared,owner,agent],[privateRun,personal,owner,agent],[orphanRun,null,owner,agent],[foreignRun,foreignIssue,foreign,agent]]) {
      await pool.query('insert into agent_runs (id,"userId","issueId","agentId",status,prompt,error,"stopReason",report) values ($1,$2,$3,$4,\'running\',\'secret-prompt\',\'secret-error\',\'secret-stop\',$5)', [id,u,issue,a,JSON.stringify({summary:'secret-report',memory:'secret-memory'})])
      await pool.query('insert into run_chunks (id,"runId",seq,chunk) values ($1,$2,1,$3)', [randomUUID(),id,JSON.stringify({type:'text-delta',delta:'secret-output'})])
      await pool.query('insert into run_messages (id,"runId","userId",text) values ($1,$2,$3,\'secret-message\')', [randomUUID(),id,u])
    }
    assert.equal((await issueForUser(owner,personal))?.id,personal)
    assert.equal((await issueForUser(owner,unlinked))?.id,unlinked)
    assert.equal(await issueForUser(member,personal),null)
    assert.equal((await issueForUser(member,shared))?.id,shared)
    assert.equal(await issueForUser(member,foreignIssue),null)
    assert.equal(await issueForUser(member,unlinked),null)
    // Exhaust the application pool as concurrent Factory transactions do.
    const scope = createRequestDatabaseScope(url!)
    await scope.run(async () => {
      const clients = await Promise.all(Array.from({ length: 5 }, () => appPool.connect()))
      await Promise.all(clients.map(client => client.query('BEGIN')))
      let timer: ReturnType<typeof setTimeout> | undefined
      const reads = Promise.all(clients.map(client => issueForUser(member,shared,false,drizzle(client))))
      try {
        const result = await Promise.race([reads, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('visibility requested another application connection')), 5000)
        })])
        assert.ok(result.every(issue => issue?.id === shared))
      } finally {
        clearTimeout(timer)
        await Promise.all(clients.map(client => client.query('ROLLBACK')))
        clients.forEach(client => client.release())
        await reads.catch(() => undefined)
      }
    }).finally(() => scope.close())
    const list = await db.select({id:issues.id}).from(issues).where((await issueVisibility(member)).predicate)
    assert.deepEqual(list.map(x=>x.id).filter(id=>new Set<string>([shared,personal,foreignIssue,unlinked]).has(id)).sort(),[shared])
    for (const user of [member,foreign]) {
      assert.equal(await tools.getIssue(user,personal),null)
      assert.equal((await tools.listIssues(user,{})).some(row=>row.id===personal),false)
      assert.equal((await actions.searchIssues(user,{query:personal})).length,0)
      assert.equal(await readRun(user,privateRun),null)
      assert.equal(await readRun(user,orphanRun),null)
    }
    assert.equal(await readRun(foreign,sharedRun),null)
    assert.equal((await readRun(owner,orphanRun))?.run.id,orphanRun)
    assert.equal((await readRun(owner,privateRun))?.run.id,privateRun)
    assert.equal((await readRun(owner,sharedRun))?.chunks.length,1)
    assert.equal((await readRun(owner,sharedRun))?.messages.length,1)
    assert.equal((await readRun(owner,sharedRun))?.run.report?.summary,'secret-report')
    const detail = await readRun(member,sharedRun)
    assert.ok(detail)
    assert.equal(detail.run.status,'running')
    assert.equal(detail.run.agentId,'')
    assert.deepEqual(detail.chunks,[])
    assert.deepEqual(detail.messages,[])
    assert.equal(JSON.stringify(detail).includes('secret'),false)
    assert.equal(JSON.stringify(detail).includes('private-agent'),false)
    assert.deepEqual((await visibleRuns(member,{issueId:shared})).map(run=>run.id),[sharedRun])
    assert.deepEqual((await tools.listRuns(member,{issueId:shared})).map(run=>run.id),[sharedRun])
    assert.ok(await tools.getRun(member,sharedRun))
    assert.equal(await actions.getRunEvents(member,{runId:sharedRun}),null)
    await assert.rejects(addRunMessage(member,{runId:sharedRun,text:'must not send'}))
    await requestRunStop(member,sharedRun)
    assert.equal((await pool.query('select "stopRequestedAt" from agent_runs where id=$1',[sharedRun])).rows[0].stopRequestedAt,null)
    const choices = await issuePropertyChoices(member)
    assert.deepEqual(choices.agents.map(row=>row.id),[ownAgent])
    assert.deepEqual(choices.labels.map(row=>row.name).sort(),['shared-label'])
    assert.equal(await readRun(foreign,sharedRun),null)
    const citations = await citationSources(member,[`[[issue:${personal}]] [[run:${sharedRun}]]`])
    assert.equal(JSON.stringify(citations).includes('private-agent'),false)
    assert.equal(citations[personal],undefined)
    assert.equal(citations[sharedRun]?.kind,'run')
    // Revoke after a successful read: no per-request/global positive cache.
    await pool.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=$2',[workspace,member])
    assert.equal(await issueForUser(member,shared),null)
    assert.equal(await tools.getRun(member,sharedRun),null)
    assert.deepEqual(await visibleRuns(member,{issueId:shared}),[])
    await pool.query('update mikka_workspace_members set status=\'active\' where "workspaceId"=$1 and "userId"=$2',[workspace,member])
    await pool.query('update issues set scope=\'personal\' where id=$1',[shared])
    assert.equal(await issueForUser(member,shared),null)
    assert.equal(await readRun(member,sharedRun),null)
    assert.equal((await readRun(owner,sharedRun))?.run.id,sharedRun)
  } finally {
    await pool.query('delete from run_messages where "runId"=any($1::uuid[])',[[sharedRun,privateRun,orphanRun,foreignRun]])
    await pool.query('delete from agent_runs where id=any($1::uuid[])',[[sharedRun,privateRun,orphanRun,foreignRun]])
    await pool.query('delete from agents where id=any($1::uuid[])',[[agent,ownAgent]])
    await pool.query('delete from issue_members where "issueId"=any($1::uuid[])',[[shared,personal,foreignIssue,unlinked]])
    await pool.query('delete from mikka_team_issues where "issueId"=any($1::uuid[])',[[shared,personal,foreignIssue,unlinked]])
    await pool.query('delete from issues where id=any($1::uuid[])',[[shared,personal,foreignIssue,unlinked]])
    await pool.query('delete from mikka_teams where id=any($1::uuid[])',[[team,otherTeam]])
    await pool.query('delete from mikka_workspace_members where "workspaceId"=any($1::uuid[])',[[workspace,otherWorkspace]])
    await pool.query('delete from mikka_workspaces where id=any($1::uuid[])',[[workspace,otherWorkspace]])
    await pool.query('delete from "user" where id=any($1::text[])',[[owner,member,foreign]])
    await pool.end()
  }
})
