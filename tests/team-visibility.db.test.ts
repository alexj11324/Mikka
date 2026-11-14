import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import type { RunFailure } from '@mikka/protocol/run-failure'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { nextTaskListCursor } from '../lib/task-list-page'
import { measured, readMetrics } from './helpers/read-metrics'

// No business/local database fallback, including when REQUIRE_DB is unset.
const url = process.env.E2E_DATABASE_URL
const authorized = disposableDatabase()
if (url && !authorized) throw new Error('Visibility DB tests require a loopback *_e2e database')
if (process.env.REQUIRE_DB === '1' && !authorized) throw new Error('Visibility database tests cannot skip in required CI')

test('real API/core visibility: immutable tenant, optional Team, provider scope and suspension', { skip: !authorized }, async t => {
  // Server actions need a Next request boundary even when actAs pins a valid workspace.
  // Supply only the browser transport; authentication and ACL still use the real fixture DB.
  const request = mock.module('next/headers', { namedExports: {
    headers: async () => new Headers(),
    cookies: async () => ({ get: () => undefined }),
  } })
  t.after(() => request.restore())
  const intl = await import('next-intl/server')
  const locale = mock.module('next-intl/server', { namedExports: { ...intl, getLocale: async () => 'en',
    getTranslations: async () => Object.assign((key: string) => key, { has: () => true }) } })
  t.after(() => locale.restore())
  const { Pool } = await import('pg')
  const { drizzle } = await import('drizzle-orm/node-postgres')
  const pool = new Pool({ connectionString: url, max: 2 })
  const { issueForUser } = await import('../lib/issue-access')
  const { issueVisibility } = await import('../lib/issue-visibility')
  const { actAs } = await import('../lib/acting-user')
  const { tokenWorkspace } = await import('../lib/tokens/principal')
  const scoped = <T>(userId: string, workspaceId: string, work: () => Promise<T>) => actAs({ id: userId, [tokenWorkspace]: workspaceId }, work)
  const { db, pool: appPool, createRequestDatabaseScope } = await import('../lib/db')
  const { issues } = await import('../lib/db/schema')
  const { readRun, visibleRuns, addRunMessage, requestRunStop } = await import('../lib/agent-runs')
  const tools = await import('../lib/mcp/tools')
  const actions = await import('../lib/mcp/actions')
  const { listTeamMembers } = await import('../app/actions/teams')
  const { citationSources } = await import('../lib/coordinator/store')
  const { issuePropertyChoices } = await import('../lib/issue-property-choices')
  const { registeredTask } = await import('./helpers/registered-task')
  const owner = `visibility-owner-${randomUUID()}`, member = `visibility-member-${randomUUID()}`, foreign = `visibility-foreign-${randomUUID()}`
  const workspace = randomUUID(), otherWorkspace = randomUUID(), personalWorkspace = randomUUID(), team = randomUUID(), otherTeam = randomUUID()
  const shared = randomUUID(), personal = randomUUID(), foreignIssue = randomUUID(), unlinked = randomUUID()
  const agent = randomUUID(), ownAgent = randomUUID(), sharedRun = randomUUID(), privateRun = randomUUID(), orphanRun = randomUUID(), foreignRun = randomUUID()
  let number = 0
  const doc = (label: string) => JSON.stringify({ type: 'doc', attrs: { mikka: { number: ++number, labels: [{ name: label, color: 'blue' }] } }, content: [] })
  try {
    for (const [id, name] of [[owner, 'Owner'], [member, 'Member'], [foreign, 'Foreign']]) await pool.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$2,$3,true,now(),now())', [id, name, `${id}@example.invalid`])
    for (const [id, user, kind] of [[workspace, owner, 'team'], [otherWorkspace, foreign, 'team'], [personalWorkspace, owner, 'personal']]) await pool.query('insert into mikka_workspaces (id,"userId",name,kind) values ($1,$2,$3,$4)', [id,user,`Visibility ${id}`,kind])
    for (const [w,u] of [[workspace,owner],[workspace,member],[otherWorkspace,foreign],[personalWorkspace,owner]]) await pool.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,$2,$3,\'member\',\'active\')', [w,u,`${u}@example.invalid`])
    for (const [id,w,u] of [[team,workspace,owner],[otherTeam,otherWorkspace,foreign]]) await pool.query('insert into mikka_teams (id,"workspaceId","userId",name,identifier) values ($1,$2,$3,\'Visibility\',\'VIS\')', [id,w,u])
    for (const [id,u,scope,label,tenant] of [[shared,owner,'workspace','shared-label',workspace],[personal,owner,'personal','secret-label',personalWorkspace],[foreignIssue,foreign,'workspace','foreign-label',otherWorkspace],[unlinked,owner,'workspace','invite-label',workspace]]) {
      await registeredTask(pool, u, tenant, id, client =>
        client.query('insert into issues (id,"userId",title,content,status,priority,scope,"workspaceId") values ($1,$2,$3,$4,\'doing\',\'normal\',$5,$6)', [id,u,id,doc(label),scope,tenant]))
      await pool.query('insert into issue_members ("issueId","userId","memberId") values ($1,$2,$3)', [id,u,member])
    }
    // A stale Team/invitation cannot override a task's stored personal tenant.
    for (const id of [shared,personal]) await pool.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)', [id,team,workspace,owner])
    await pool.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)', [foreignIssue,otherTeam,otherWorkspace,foreign])
    for (const [id,u] of [[agent,owner],[ownAgent,member]]) await pool.query('insert into agents (id,"userId",harness,name,instructions) values ($1,$2,\'codex\',$3,\'secret-standing-instructions\')', [id,u,`private-agent-${id}`])
    for (const [id,issue,u,a] of [[sharedRun,shared,owner,agent],[privateRun,personal,owner,agent],[orphanRun,null,owner,agent],[foreignRun,foreignIssue,foreign,agent]]) {
      await pool.query('insert into agent_runs (id,"userId","issueId","agentId",status,prompt,error,"stopReason",report,"workspaceId") values ($1,$2,$3,$4,\'running\',\'secret-prompt\',\'secret-error\',\'secret-stop\',$5,$6)', [id,u,issue,a,JSON.stringify({summary:'secret-report',memory:'secret-memory'}),issue===shared?workspace:issue===foreignIssue?otherWorkspace:personalWorkspace])
      await pool.query('insert into run_chunks (id,"runId",seq,chunk) values ($1,$2,1,$3)', [randomUUID(),id,JSON.stringify({type:'text-delta',delta:'secret-output'})])
      await pool.query('insert into run_messages (id,"runId","userId",text) values ($1,$2,$3,\'secret-message\')', [randomUUID(),id,u])
    }
    const failureDetails: RunFailure = { schemaVersion: 1, code: 'run_api_key_invalid', category: 'api_key', provider: 'openai', status: 401,
      providerMessage: 'secret-provider-message', causes: [{ name: 'APIError', code: 'invalid_api_key' }],
      runId: sharedRun, appVersion: 'test', occurredAt: '2026-11-07T12:00:00.000Z' }
    await pool.query('update agent_runs set "failureDetails"=$2 where id=$1', [sharedRun, JSON.stringify(failureDetails)])
    assert.equal((await issueForUser(owner,personal))?.id,personal)
    assert.equal((await issueForUser(owner,unlinked))?.id,unlinked)
    assert.equal(await issueForUser(member,personal),null)
    assert.equal((await issueForUser(member,shared))?.id,shared)
    assert.equal(await issueForUser(member,foreignIssue),null)
    assert.equal((await issueForUser(member,unlinked))?.id,unlinked,'a Team is optional inside the authorized workspace')
    const teamCount = (id: string, tenant: string) => scoped(id, tenant, () => listTeamMembers(team, tenant, true))
    assert.equal((await teamCount(member, workspace)).taskCount, 1, 'a stale Team link from another tenant is not counted')
    assert.equal((await scoped(member, workspace, () => listTeamMembers(team, workspace))).taskCount, undefined)
    await assert.rejects(teamCount(foreign, otherWorkspace))
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
    assert.deepEqual(list.map(x=>x.id).filter(id=>new Set<string>([shared,personal,foreignIssue,unlinked]).has(id)).sort(),[shared,unlinked].sort())
    for (const user of [member,foreign]) {
      assert.equal(await scoped(user, user === member ? workspace : otherWorkspace, () => tools.getIssue(user,personal)),null)
      assert.equal((await scoped(user, user === member ? workspace : otherWorkspace, () => tools.listIssues(user,{}))).some(row=>row.id===personal),false)
      assert.equal((await scoped(user, user === member ? workspace : otherWorkspace, () => actions.searchIssues(user,{query:personal}))).length,0)
      assert.equal(await readRun(user,privateRun),null)
      assert.equal(await readRun(user,orphanRun),null)
    }
    await assert.rejects(tools.getIssue(owner, shared), /workspaceAccessDenied/, 'an unscoped MCP call cannot aggregate memberships')
    assert.equal(await scoped(owner, personalWorkspace, () => tools.getIssue(owner, shared)), null, 'the same account cannot read a task outside its selected tenant')
    assert.equal((await scoped(owner, personalWorkspace, () => tools.listIssues(owner, {}))).some(row => row.id === shared), false)
    assert.equal(await readRun(foreign,sharedRun),null)
    assert.equal((await readRun(owner,orphanRun))?.run.id,orphanRun)
    assert.equal((await readRun(owner,privateRun))?.run.id,privateRun)
    assert.equal((await readRun(owner,sharedRun))?.chunks.length,1)
    assert.equal((await readRun(owner,sharedRun))?.messages.length,1)
    assert.equal((await readRun(owner,sharedRun))?.run.report?.summary,'secret-report')
    assert.deepEqual((await readRun(owner,sharedRun))?.run.failureDetails, failureDetails)
    await t.test('MCP run lists and nested issue run summaries do not transfer report bodies', async subtest => {
      const read = () => scoped(owner, workspace, async () => ({
        list: await tools.listRuns(owner, { issueId: shared }),
        nested: (await tools.getIssue(owner, shared))?.runs,
      }))
      await read()
      const before = await measured(read)
      await pool.query(`UPDATE agent_runs SET report = report || jsonb_build_object('opaqueReport', repeat('r',32768))
        WHERE id=$1`, [sharedRun])
      try {
        const after = await measured(read)
        subtest.diagnostic(JSON.stringify({ normal: readMetrics(before), largeReport: readMetrics(after) }))
        assert.deepEqual(after.value, before.value)
        assert.equal(after.value.list[0]?.id, sharedRun)
        assert.equal(after.value.nested?.[0]?.id, sharedRun)
        assert.equal(after.value.list[0]?.stopReason, 'secret-stop')
        const peer = await scoped(member, workspace, () => tools.listRuns(member, { issueId: shared, activeOnly: true }))
        assert.equal(peer[0]?.id, sharedRun)
        assert.equal(peer[0]?.agent, 'codex')
        assert.equal(peer[0]?.stopReason, null)
        assert.equal(after.resultBytes, before.resultBytes, 'status-only projections never read a full report')
      } finally {
        await pool.query(`UPDATE agent_runs SET report = report - 'opaqueReport' WHERE id=$1`, [sharedRun])
      }
    })
    const ownBrief = await visibleRuns(owner, { issueId: shared, brief: true })
    assert.equal(ownBrief[0].failureDetails?.code, 'run_api_key_invalid')
    assert.doesNotMatch(JSON.stringify(ownBrief[0].failureDetails), /secret-provider-message|APIError/)
    const detail = await readRun(member,sharedRun)
    assert.ok(detail)
    assert.equal(detail.run.status,'running')
    assert.equal(detail.run.failureDetails?.code, 'run_api_key_invalid')
    assert.equal(Object.hasOwn(detail.run.failureDetails!, 'providerMessage'), false)
    assert.equal(Object.hasOwn(detail.run.failureDetails!, 'causes'), false)
    assert.equal(detail.run.agentId,'')
    assert.deepEqual(detail.chunks,[])
    assert.deepEqual(detail.messages,[])
    assert.equal(JSON.stringify(detail).includes('secret'),false)
    assert.equal(JSON.stringify(detail).includes('private-agent'),false)
    assert.deepEqual((await visibleRuns(member,{issueId:shared})).map(run=>run.id),[sharedRun])
    assert.deepEqual((await scoped(member, workspace, () => tools.listRuns(member,{issueId:shared}))).map(run=>run.id),[sharedRun])
    assert.ok(await scoped(member, workspace, () => tools.getRun(member,sharedRun)))
    assert.equal(await scoped(member, workspace, () => actions.getRunEvents(member,{runId:sharedRun})),null)
    await assert.rejects(addRunMessage(member,{runId:sharedRun,text:'must not send'}))
    await assert.rejects(requestRunStop(member,sharedRun), /runNotFound/)
    assert.equal((await pool.query('select "stopRequestedAt" from agent_runs where id=$1',[sharedRun])).rows[0].stopRequestedAt,null)
    const choices = await issuePropertyChoices(member)
    assert.equal(Object.hasOwn(choices, 'agents'), false, 'task properties do not list execution identities, including your own')
    assert.deepEqual(choices.labels.map(row=>row.name).sort(),['invite-label','shared-label'])
    assert.equal(await readRun(foreign,sharedRun),null)
    const citations = await citationSources(member,[`[[issue:${personal}]] [[run:${sharedRun}]]`])
    assert.equal(JSON.stringify(citations).includes('private-agent'),false)
    assert.equal(citations[personal],undefined)
    assert.equal(citations[sharedRun]?.kind,'run')
    // A Team whose rows fall outside the global top 100 must still load its
    // own first page, traverse its own cursor, and reject foreign-Team anchors.
    const overflowTeam = randomUUID()
    const overflowIds: string[] = []
    try {
      await pool.query('insert into mikka_teams (id,"workspaceId","userId",name,identifier) values ($1,$2,$3,\'Overflow\',\'OVER\')', [overflowTeam,workspace,owner])
      const generated = await pool.query<{ id: string; title: string }>(`insert into issues(id,"userId","workspaceId","ownershipState",scope,title,content,status,priority,"updatedAt")
        select gen_random_uuid(), $1, $2, 'bound', 'workspace', tag || n,
          '{"type":"doc"}'::jsonb,'todo','normal',
          case when tag='Overflow' then '2030-01-01'::timestamptz else '2020-01-01'::timestamptz end + n * interval '1 microsecond'
        from (select 'Overflow' as tag, generate_series(1,105) n union all
          select 'Target' as tag, generate_series(1,102) n) batch returning id,title`, [owner,workspace])
      overflowIds.push(...generated.rows.map(row => row.id))
      await pool.query(`insert into mikka_team_issues ("issueId","teamId","workspaceId","userId")
        select task.id, case when task.title like 'Overflow%' then $2::uuid else $3::uuid end, $4::uuid, $5
        from unnest($1::uuid[], $6::text[]) task(id,title)`,
        [overflowIds, overflowTeam,team,workspace,owner,generated.rows.map(row => row.title)])
      const { listWorkspaceIssues, listWorkspaceTaskPage } = await import('../app/actions/issues')
      const list = await scoped(owner,workspace,() => listWorkspaceIssues(workspace))
      assert.equal(list.length,100)
      assert.equal(list.some(issue => issue.id === shared),false,'global page excludes the older target Team')
      const first = await scoped(member,workspace,() => listWorkspaceTaskPage({ workspaceId: workspace, teamId: team, after: null }))
      assert.equal(first.items.length,100)
      assert.ok(first.items.some(issue => issue.id === shared),'the Team can read its own older Task')
      assert.ok(first.items.every(issue => issue.teamId === team))
      const last = await scoped(member,workspace,() => listWorkspaceTaskPage({ workspaceId: workspace, teamId: team, after: first.next! }))
      assert.equal(last.items.length,3)
      assert.equal(last.next,null)
      assert.equal(new Set([...first.items,...last.items].map(issue => issue.id)).size,103)
      const globalCursor = nextTaskListCursor(list)!
      const stale = await scoped(member,workspace,() => listWorkspaceTaskPage({ workspaceId: workspace, teamId: team, after: globalCursor }))
      assert.equal(stale.reset,true,'a cursor from another Team is never a valid Team page anchor')
      await assert.rejects(scoped(member,workspace,() => listWorkspaceTaskPage({ workspaceId: workspace, teamId: otherTeam, after: null })), /teamNotFound/)
    } finally {
      await pool.query('delete from mikka_team_issues where "issueId"=any($1::uuid[])',[overflowIds])
      await pool.query('delete from issues where id=any($1::uuid[])',[overflowIds])
      await pool.query('delete from mikka_teams where id=$1',[overflowTeam])
    }
    // Revoke after a successful read: no per-request/global positive cache.
    await pool.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=$2',[workspace,member])
    assert.equal(await issueForUser(member,shared),null)
    await assert.rejects(teamCount(member, workspace))
    assert.equal(await scoped(member, workspace, () => tools.getRun(member,sharedRun)),null)
    assert.deepEqual(await visibleRuns(member,{issueId:shared}),[])
    await pool.query('update mikka_workspace_members set status=\'active\' where "workspaceId"=$1 and "userId"=$2',[workspace,member])
    await pool.query('update issues set scope=\'personal\' where id=$1',[shared])
    assert.equal((await issueForUser(member,shared))?.id,shared,'a provider scope label cannot move the task out of its tenant')
    assert.equal((await readRun(member,sharedRun))?.run.id,sharedRun)
    assert.equal((await readRun(owner,sharedRun))?.run.id,sharedRun)
  } finally {
    await pool.query('delete from run_messages where "runId"=any($1::uuid[])',[[sharedRun,privateRun,orphanRun,foreignRun]])
    await pool.query('delete from agent_runs where id=any($1::uuid[])',[[sharedRun,privateRun,orphanRun,foreignRun]])
    await pool.query('delete from agents where id=any($1::uuid[])',[[agent,ownAgent]])
    await pool.query('delete from issue_members where "issueId"=any($1::uuid[])',[[shared,personal,foreignIssue,unlinked]])
    await pool.query('delete from mikka_team_issues where "issueId"=any($1::uuid[])',[[shared,personal,foreignIssue,unlinked]])
    await pool.query('delete from issues where id=any($1::uuid[])',[[shared,personal,foreignIssue,unlinked]])
    await pool.query('delete from mikka_teams where id=any($1::uuid[])',[[team,otherTeam]])
    await pool.query('delete from mikka_workspace_members where "workspaceId"=any($1::uuid[])',[[workspace,otherWorkspace,personalWorkspace]])
    await pool.query('delete from mikka_workspaces where id=any($1::uuid[])',[[workspace,otherWorkspace,personalWorkspace]])
    await pool.query('delete from "user" where id=any($1::text[])',[[owner,member,foreign]])
    await pool.end()
  }
})
