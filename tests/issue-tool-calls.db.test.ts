import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { seedCoordinator } from './support/coordinator-bot'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol/daemon'
import { normalizeRepository } from '@mikka/protocol/repository'

const connection = process.env.E2E_DATABASE_URL
const required = process.env.REQUIRE_DB === '1'
const enabled = process.env.CI === 'true' && process.env.GITHUB_ACTIONS === 'true' && !!connection
if (required && !enabled) throw new Error('Issue mutation DB regression requires GitHub Actions temporary PG17')
if (enabled) {
  const url = new URL(connection!)
  assert.equal(url.hostname, '127.0.0.1')
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol))
  assert.equal(url.port, '5432')
  assert.equal(url.pathname, '/mikka_e2e')
  assert.equal(process.env.MIKKA_DATABASE_URL, connection)
  assert.equal(process.env.DATABASE_URL, connection, 'workspace and issue stores must share only this disposable target')
  process.env.MIKKA_ISSUE_TOOLS_ENABLED = '1'
}

test('actual issue actions commit one issue per tool call, roll back partial writes, and preserve history on replay', { skip: !enabled }, async () => {
  const { pool } = await import('../lib/db')
  const { createIssue, updateIssue } = await import('../lib/mcp/actions')
  const { createCoordinatorRegistry } = await import('../workflows/coordinator/tools')
  const { systemActor, agentActor } = await import('../lib/activity-actor')
  const { withActivitySession } = await import('./fixtures/activity-runtime.mjs')
  const { promoteIssueToTeam } = await import('../app/actions/issues')
  const owner = `issue-tools-${randomUUID()}`
  const stranger = `issue-tools-${randomUUID()}`
  const callId = `create-${randomUUID()}`
  const workspace = randomUUID(), team = randomUUID()
  const legacyAgent = randomUUID()
  const actor = systemActor('coordinator')
  const input = { title: 'Repair the login flow', labels: ['regression'], assigneeUserId: owner }
  const count = async (table: string) => Number((await pool.query(`select count(*) from ${table} where "userId"=$1`, [owner])).rows[0].count)
  try {
    assert.equal((await pool.query('show server_version_num')).rows[0].server_version_num.slice(0, 2), '17')
    for (const id of [owner, stranger]) await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,false,now(),now())', [id, `${id}@example.invalid`])
    // The owner's Coordinator is an ordinary bot row; its tools write as that bot.
    const coordinator = (await seedCoordinator(owner)).botId
    await pool.query('insert into agents (id,"userId",harness,name) values ($1,$2,\'codex\',\'Legacy fixture\')', [legacyAgent, stranger])
    process.env.MIKKA_ISSUE_TOOLS_ENABLED = '0'
    const legacy = await createIssue(stranger, { title: 'Existing MCP path without rollout', assigneeAgentId: null }, actor)
    assert.ok('id' in legacy)
    const assigned = await updateIssue(stranger, { issueId: legacy.id, assigneeAgentId: legacyAgent }, agentActor(legacyAgent))
    assert.ok('id' in assigned, 'the pre-existing MCP agent assignment remains accepted')
    assert.equal(assigned.assignee, 'Legacy fixture')
    assert.ok('id' in await updateIssue(stranger, { issueId: legacy.id, assigneeAgentId: null }, actor), 'the pre-existing MCP agent field remains accepted')
    assert.deepEqual(await createIssue(stranger, { title: 'Ambiguous', assigneeAgentId: null, assigneeUserId: stranger }, actor), { error: 'validationGeneric' })
    assert.deepEqual(await createIssue(stranger, { title: 'Queued step after shutdown' }, actor, `disabled-${randomUUID()}`), { error: 'issueToolsDisabled' })
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM issue_tool_calls WHERE "userId"=$1', [stranger])).rows[0].n, 0, 'disabled rollout preserves legacy MCP behavior without a receipt dependency')
    for (let retry = 0; retry < 2; retry++) {
      assert.deepEqual(await createIssue(owner, { title: 'Unapproved human assignment', assigneeUserId: stranger }, actor), { error: 'issueToolsDisabled' })
      assert.equal(await count('issues'), 0)
      assert.equal(await count('issue_versions'), 0)
      assert.equal(await count('issue_tool_calls'), 0)
    }
    process.env.MIKKA_ISSUE_TOOLS_ENABLED = '1'
    // The actual registered Workflow tool invokes its scoped step and shared
    // actions. No test-only issue writer stands in for the Coordinator.
    const tools = createCoordinatorRegistry(owner, coordinator, undefined, { coordinator: true })
    const create = () => tools.create_issue!.execute!(input, { toolCallId: callId, messages: [], context: {} })
    const results = await Promise.all([create(), create()])
    assert.ok('id' in results[0], JSON.stringify(results[0]))
    assert.deepEqual(results[0], results[1])
    assert.equal(await count('issues'), 1)
    assert.equal(await count('issue_tool_calls'), 1)
    const id = results[0].id as string
    assert.deepEqual(await updateIssue(owner, { issueId: id, assigneeAgentId: legacyAgent }, agentActor(legacyAgent)), { error: 'agentNotFound' }, 'legacy MCP cannot assign another owner’s agent')
    const versions = await count('issue_versions')
    process.env.MIKKA_ISSUE_TOOLS_ENABLED = '0'
    assert.deepEqual(await createIssue(owner, { ...input }, actor, callId), { error: 'issueToolsDisabled' })
    assert.deepEqual(await updateIssue(owner, { issueId: id, title: 'Disabled retry' }, actor, `disabled-update-${randomUUID()}`), { error: 'issueToolsDisabled' })
    assert.equal(await count('issues'), 1)
    assert.equal(await count('issue_versions'), versions)
    assert.equal(await count('issue_tool_calls'), 1)
    process.env.MIKKA_ISSUE_TOOLS_ENABLED = '1'
    assert.deepEqual(await createIssue(owner, { ...input }, actor, callId), results[0])
    assert.equal(await count('issue_versions'), versions)
    assert.deepEqual(await createIssue(owner, { ...input, title: 'Different request' }, actor, callId), { error: 'issueToolCallConflict' })
    assert.equal(await count('issues'), 1)

    // The issue insert and its history must disappear if a later metadata write fails.
    assert.deepEqual(await createIssue(owner, { title: 'Must roll back', assigneeUserId: stranger }, actor, `invalid-${randomUUID()}`), { error: 'memberNotJoined' })
    assert.equal(await count('issues'), 1)
    assert.equal(await count('issue_versions'), versions)
    assert.equal(await count('issue_tool_calls'), 1)

    await pool.query('INSERT INTO issue_members ("issueId","userId","memberId") VALUES ($1,$2,$3)', [id, owner, stranger])
    const unchanged = async (operation: () => Promise<unknown>) => {
      const before = (await pool.query('SELECT title,content,revision FROM issues WHERE id=$1', [id])).rows[0]
      const versions = await count('issue_versions'), receipts = await count('issue_tool_calls')
      assert.deepEqual(await operation(), { error: 'memberNotJoined' })
      assert.deepEqual((await pool.query('SELECT title,content,revision FROM issues WHERE id=$1', [id])).rows[0], before)
      assert.equal(await count('issue_versions'), versions)
      assert.equal(await count('issue_tool_calls'), receipts)
    }
    await unchanged(() => updateIssue(owner, { issueId: id, title: 'Must not partially write', assigneeUserId: stranger }, actor, `personal-invite-${randomUUID()}`))
    await pool.query('INSERT INTO mikka_workspaces (id,"userId",name) VALUES ($1,$2,$3)', [workspace, owner, 'Issue tools fixture'])
    await pool.query('INSERT INTO mikka_teams (id,"workspaceId","userId",name,identifier) VALUES ($1,$2,$3,$4,$5)', [team, workspace, owner, 'Issue tools', `IT${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`])
    await pool.query('INSERT INTO mikka_team_issues ("issueId","teamId","workspaceId","userId") VALUES ($1,$2,$3,$4)', [id, team, workspace, owner])
    for (const member of [owner, stranger]) await pool.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$3,$4,$5,$6)', [workspace, member, 'Fixture member', `${member}@example.invalid`, 'member', 'active'])
    // Sharing is a separate explicit human choice, never a Coordinator or SQL
    // scope inference. Preserve the real receipt/permission transaction here.
    const revision = (await pool.query('SELECT revision FROM issues WHERE id=$1', [id])).rows[0].revision
    const promotion = await withActivitySession(owner, () => promoteIssueToTeam({ requestId: randomUUID(), issueId: id, revision, teamId: team, expectedTeamId: team }))
    assert.ok('issue' in promotion && promotion.issue, JSON.stringify(promotion))
    assert.equal(promotion.issue.scope, 'workspace')
    assert.equal(promotion.issue.linearSyncBlocked, true)
    const [humanVersion] = (await pool.query('SELECT id,actor_type,actor_id FROM issue_versions WHERE "issueId"=$1 AND revision=$2', [id, promotion.issue.revision])).rows
    assert.deepEqual({ type: humanVersion.actor_type, id: humanVersion.actor_id }, { type: 'user', id: owner })
    assert.ok('id' in await updateIssue(owner, { issueId: id, assigneeUserId: stranger }, actor, `active-assignee-${randomUUID()}`), 'currently accessible human members remain assignable')
    await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace, stranger])
    await unchanged(() => updateIssue(owner, { issueId: id, assigneeUserId: stranger }, actor, `suspended-assignee-${randomUUID()}`))
    await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [workspace, stranger])
    await unchanged(() => updateIssue(owner, { issueId: id, assigneeUserId: stranger }, actor, `removed-assignee-${randomUUID()}`))
    for (let retry = 0; retry < 2; retry++) {
      const before = (await pool.query('SELECT title,content,revision FROM issues WHERE id=$1', [id])).rows[0]
      assert.deepEqual(await updateIssue(owner, { issueId: id, title: 'No partial edit', assigneeUserId: stranger }, actor), { error: 'issueToolsDisabled' })
      assert.deepEqual((await pool.query('SELECT title,content,revision FROM issues WHERE id=$1', [id])).rows[0], before)
    }

    const updateCall = `update-${randomUUID()}`
    const changed = await updateIssue(owner, { issueId: id, title: 'Updated title', status: 'doing' }, actor, updateCall)
    assert.ok('id' in changed)
    const changedVersions = await count('issue_versions')
    assert.deepEqual(await updateIssue(owner, { issueId: id, title: 'Updated title', status: 'doing' }, actor, updateCall), changed)
    assert.equal(await count('issue_versions'), changedVersions)
    await updateIssue(owner, { issueId: id, title: 'Later user request' }, actor, `later-${randomUUID()}`)
    assert.deepEqual(await updateIssue(owner, { issueId: id, title: 'Updated title', status: 'doing' }, actor, updateCall), changed)
    assert.equal((await pool.query('select title from issues where id=$1', [id])).rows[0].title, 'Later user request')
    assert.deepEqual(await updateIssue(stranger, { issueId: id, title: 'Unauthorized' }, actor, `foreign-${randomUUID()}`), { error: 'issueNotFound' })
    assert.ok('id' in await createIssue(stranger, { title: 'Separate owner' }, actor, callId), 'same tool call id is scoped to owner')
    // MCP writes name the Coordinator by its old system actor; the registered tools write as its bot row.
    assert.equal((await pool.query('select count(*) from issue_versions where "userId"=$1 and actor_type=\'system\' and actor_id in (\'coordinator\', $2)', [owner, coordinator])).rows[0].count, String(await count('issue_versions') - 1))
    assert.ok(Number((await pool.query('select count(*) from issue_versions where "userId"=$1 and actor_type=\'system\' and actor_id=$2', [owner, coordinator])).rows[0].count) > 0, 'the registered tools write as the Coordinator bot')
    assert.deepEqual((await pool.query('SELECT id FROM issue_versions WHERE "userId"=$1 AND actor_type=\'user\' AND actor_id=$1', [owner])).rows, [{ id: humanVersion.id }], 'only the explicit human promotion differs from the Coordinator actor matrix')
    // Exercise the actual Factory tool -> scoped Workflow step -> existing issue
    // actions -> durable receipt -> Factory store, without a model/provider.
    process.env.MIKKA_FACTORY_ROUTING_ENABLED = '1'
    const sourceId=randomUUID()
    await pool.query(`INSERT INTO coordinator_events(id,"userId","botId",kind,"dedupeKey",payload) VALUES($1,$2,$4,'user_message',$3,'{"text":"Create a task to keep the API compatible"}')`,[sourceId,owner,sourceId,coordinator])
    const factoryTools=createCoordinatorRegistry(owner,coordinator,undefined,{coordinator:true})
    const request={sourceEventId:sourceId,title:'Factory intake fixture',body:'Keep the API compatible',rationale:'Actual personal source fixture',missingInformation:[],missingPermissions:[],needsSpec:false}
    type Snapshot=import('../lib/factory/store').FactorySnapshot
    const invoke=factoryTools.intake_factory_request!.execute! as unknown as (input:unknown,options:{toolCallId:string;messages:never[];context:object})=>Promise<Snapshot|{error:string}>
    const issueCount=await count('issues')
    const routed=await Promise.all(Array.from({length:10},(_,n)=>invoke({...request,sourceEventId:n%2?sourceId.toUpperCase():sourceId},{toolCallId:`attempt-${n}`,messages:[],context:{}})))
    for(const result of routed){assert.ok('task' in result,JSON.stringify(result));assert.equal(result.task.stage,'execute');assert.equal(result.task.status,'pending')}
    assert.equal(new Set(routed.map(result=>'task' in result?result.task.id:null)).size,1)
    assert.equal(await count('issues'),issueCount+1)
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM issue_tool_calls WHERE "userId"=$1 AND "toolCallId"=$2',[owner,`factory-intake:${sourceId}`])).rows[0].n,1)
    assert.deepEqual(await invoke({...request,title:'Conflicting retry'},{toolCallId:'changed',messages:[],context:{}}),{error:'issueToolCallConflict'})
    assert.equal(await count('issues'),issueCount+1)
    process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED = '1'
    const device=randomUUID(), worker=randomUUID(), repo=randomUUID()
    const repository=normalizeRepository('https://github.com/synthetic/factory-fixture.git')
    await pool.query('INSERT INTO devices(id,"ownerId",name,kind,enabled,"protocolVersion",harnesses) VALUES($1,$2,$3,\'local\',true,$4,$5)',[device,owner,'Disposable Factory device',DAEMON_PROTOCOL_VERSION,JSON.stringify([{harness:'codex',installed:true,version:'synthetic-fixture',toolApproval:true}])])
    await pool.query('INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,$3,$4,$5)',[worker,owner,'Disposable Factory worker','codex',device])
    await pool.query('INSERT INTO device_repos(id,"deviceId","userId","repoPath","remoteUrl") VALUES($1,$2,$3,$4,$5)',[repo,device,owner,repository.key,repository.remoteUrl])
    // Only this disposable owner's repository has a synthetic persisted grant.
    // The real dispatch still executes the ordinary admission transaction.
    await pool.query('INSERT INTO repository_settings("userId","remoteKey",push) VALUES($1,$2,$3)',[owner,repository.key,JSON.stringify({approved:true,remote:'origin',approvedByUserId:owner,approvedAt:new Date().toISOString()})])
    const lifecycleTools=createCoordinatorRegistry(owner,coordinator,undefined,{coordinator:true})
    const first=routed[0];assert.ok('task' in first)
    const {factoryBinding}=await import('../lib/factory/dispatch')
    const dispatch=lifecycleTools.dispatch_factory_task!.execute! as unknown as (input:unknown,options:{toolCallId:string;messages:never[];context:object})=>Promise<import('../lib/factory/dispatch').FactoryDispatchResult|{error:string}>
    const dispatchInput={binding:factoryBinding(first.task),agentId:worker,deviceRepoId:repo}
    const executions=await Promise.all(Array.from({length:10},(_,n)=>dispatch(dispatchInput,{toolCallId:`dispatch-${n}`,messages:[],context:{}})))
    for(const execution of executions)assert.ok('runId' in execution,JSON.stringify(execution))
    assert.equal(new Set(executions.map(r=>'runId' in r?r.runId:null)).size,1)
    const frozen=(await pool.query('SELECT * FROM agent_runs WHERE "issueId"=$1',[first.task.issueId])).rows
    assert.equal(frozen.length,1);assert.equal(frozen[0].agentDefinition.kind,'worker')
    assert.equal(frozen[0].agentDefinition.harness,'codex');assert.equal(frozen[0].status,'queued')
    assert.equal(frozen[0].agentDefinition.repositoryAdmission.remoteKey,repository.key)
    assert.deepEqual((await pool.query('SELECT "runId","remoteKey","pushApproved" FROM run_publications WHERE "issueId"=$1',[first.task.issueId])).rows,[{runId:frozen[0].id,remoteKey:repository.key,pushApproved:true}])
    assert.deepEqual(await dispatch({...dispatchInput,note:'Changed'},{toolCallId:'changed',messages:[],context:{}}),{error:'factoryReplayMismatch'})
    process.env.MIKKA_FACTORY_LIFECYCLE_ENABLED = '0'
    process.env.MIKKA_FACTORY_ROUTING_ENABLED = '0'
  } finally {
    await pool.query('DELETE FROM coordinator_events WHERE "userId"=$1', [owner])
    await pool.query('DELETE FROM issue_members WHERE "userId"=$1', [owner])
    await pool.query('DELETE FROM mikka_team_issues WHERE "workspaceId"=$1', [workspace])
    await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1', [workspace])
    await pool.query('DELETE FROM mikka_teams WHERE id=$1', [team])
    await pool.query('DELETE FROM mikka_workspaces WHERE id=$1', [workspace])
    for (const id of [owner, stranger]) {
      for (const table of ['issue_tool_calls', 'issue_versions', 'issues']) await pool.query(`delete from ${table} where "userId"=$1`, [id])
      await pool.query('delete from repository_settings where "userId"=$1', [id])
      await pool.query('delete from agents where "userId"=$1', [id])
      await pool.query('delete from device_repos where "userId"=$1', [id])
      await pool.query('delete from devices where "ownerId"=$1', [id])
      await pool.query('delete from "user" where id=$1', [id])
    }
    await pool.end()
    const workspacePool = (globalThis as { workspacePool?: { end(): Promise<void> } }).workspacePool
    if (workspacePool) await workspacePool.end()
  }
})
