import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { seedCoordinator } from './support/coordinator-bot'
import { DAEMON_PROTOCOL_VERSION } from '@mikka/protocol/daemon'
import { normalizeRepository } from '@mikka/protocol/repository'
import { recordPushGrant } from './support/github-app-stub'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { seedAllowedModel } from './support/allowed-model'
import { overrideDeploymentSwitch } from '../lib/deployment-switches'

const connection = process.env.E2E_DATABASE_URL
const required = process.env.REQUIRE_DB === '1'
const enabled = disposableDatabase()
if (required && !enabled) throw new Error('Issue mutation DB regression requires a loopback *_e2e database')
if (enabled) {
  assert.equal(process.env.MIKKA_DATABASE_URL, connection)
  assert.equal(process.env.DATABASE_URL, connection, 'workspace and issue stores must share only this disposable target')
  overrideDeploymentSwitch('issueTools', true)
}

// Preserve the original failure, but let every concurrent operation finish
// before fixture deletion takes locks on the same owner/issues.
async function settledValues<T extends readonly unknown[]>(operations: T) {
  await Promise.allSettled(operations)
  return Promise.all(operations)
}

test('actual issue actions commit one issue per tool call, roll back partial writes, and preserve history on replay', { skip: !enabled }, async () => {
  const { pool } = await import('../lib/db')
  const { createIssue: createIssueAction, updateIssue: updateIssueAction } = await import('../lib/mcp/actions')
  const { actAs } = await import('../lib/acting-user')
  const { tokenWorkspace } = await import('../lib/tokens/principal')
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
  const personalWorkspaces = new Map<string, string>()
  // Direct MCP calls carry the workspace resolved by their verified credential.
  // The registered Coordinator tools resolve theirs from the host Bot instead.
  const inWorkspace = <T>(userId: string, workspaceId: string, work: () => Promise<T>) => actAs({ id: userId, [tokenWorkspace]: workspaceId }, work)
  const createIssue = (...args: Parameters<typeof createIssueAction>) => inWorkspace(args[0], personalWorkspaces.get(args[0])!, () => createIssueAction(...args))
  const updateIssue = (...args: Parameters<typeof updateIssueAction>) => inWorkspace(args[0], personalWorkspaces.get(args[0])!, () => updateIssueAction(...args))
  const input = { title: 'Repair the login flow', labels: ['regression'], assigneeUserId: owner }
  const count = async (table: string) => Number((await pool.query(`select count(*) from ${table} where "userId"=$1`, [owner])).rows[0].count)
  try {
    assert.equal((await pool.query('show server_version_num')).rows[0].server_version_num.slice(0, 2), '17')
    for (const id of [owner, stranger]) await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,false,now(),now())', [id, `${id}@example.invalid`])
    // The owner's Coordinator is an ordinary bot row; its tools write as that bot.
    const ownCoordinator = await seedCoordinator(owner)
    const coordinator = ownCoordinator.botId
    personalWorkspaces.set(owner, ownCoordinator.workspaceId)
    personalWorkspaces.set(stranger, (await seedCoordinator(stranger)).workspaceId)
    await pool.query('insert into agents (id,"userId",harness,name) values ($1,$2,\'codex\',\'Legacy fixture\')', [legacyAgent, stranger])
    overrideDeploymentSwitch('issueTools', false)
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
    overrideDeploymentSwitch('issueTools', true)
    // The actual registered Workflow tool invokes its scoped step and shared
    // actions. No test-only issue writer stands in for the Coordinator.
    const tools = createCoordinatorRegistry(owner, coordinator, undefined, { coordinator: true })
    const create = () => tools.create_issue!.execute!(input, { toolCallId: callId, messages: [], context: {} })
    const results = await settledValues([create(), create()])
    assert.ok('id' in results[0], JSON.stringify(results[0]))
    assert.deepEqual(results[0], results[1])
    assert.equal(await count('issues'), 1)
    assert.equal(await count('issue_tool_calls'), 1)
    const id = results[0].id as string
    assert.deepEqual((await pool.query('SELECT "workspaceId","ownershipState",scope FROM issues WHERE id=$1', [id])).rows, [{ workspaceId: ownCoordinator.workspaceId, ownershipState: 'bound', scope: 'personal' }])
    assert.deepEqual(await updateIssue(owner, { issueId: id, assigneeAgentId: legacyAgent }, agentActor(legacyAgent)), { error: 'agentNotFound' }, 'legacy MCP cannot assign another owner’s agent')
    const versions = await count('issue_versions')
    overrideDeploymentSwitch('issueTools', false)
    assert.deepEqual(await createIssue(owner, { ...input }, actor, callId), { error: 'issueToolsDisabled' })
    assert.deepEqual(await updateIssue(owner, { issueId: id, title: 'Disabled retry' }, actor, `disabled-update-${randomUUID()}`), { error: 'issueToolsDisabled' })
    assert.equal(await count('issues'), 1)
    assert.equal(await count('issue_versions'), versions)
    assert.equal(await count('issue_tool_calls'), 1)
    overrideDeploymentSwitch('issueTools', true)
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
    const unchanged = async (operation: () => Promise<unknown>, issueId = id, error = 'memberNotJoined') => {
      const snapshot = async () => ({
        issue: (await pool.query('SELECT title,content,revision,"workspaceId","ownershipState" FROM issues WHERE id=$1', [issueId])).rows[0],
        issues: await count('issues'),
        versions: (await pool.query('SELECT id FROM issue_versions WHERE "userId"=ANY($1::text[]) ORDER BY id', [[owner, stranger]])).rows,
        receipts: (await pool.query('SELECT "userId","toolCallId","issueId",result,effects FROM issue_tool_calls WHERE "userId"=ANY($1::text[]) ORDER BY "userId","toolCallId"', [[owner, stranger]])).rows,
        counters: (await pool.query('SELECT id,"lastIssueNumber" FROM "user" WHERE id=ANY($1::text[]) ORDER BY id', [[owner, stranger]])).rows,
      })
      const before = await snapshot()
      assert.deepEqual(await operation(), { error })
      assert.deepEqual(await snapshot(), before, 'denied mutations cannot write an issue, history, replay receipt or number reservation')
    }
    await unchanged(() => updateIssue(owner, { issueId: id, title: 'Must not partially write', assigneeUserId: stranger }, actor, `personal-invite-${randomUUID()}`))
    await pool.query('INSERT INTO mikka_workspaces (id,"userId",name,slug,kind) VALUES ($1,$2,$3,$4,\'team\')', [workspace, owner, 'Issue tools fixture', `issue-tools-${workspace}`])
    await pool.query('INSERT INTO mikka_teams (id,"workspaceId","userId",name,identifier) VALUES ($1,$2,$3,$4,$5)', [team, workspace, owner, 'Issue tools', `IT${randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase()}`])
    for (const member of [owner, stranger]) await pool.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$3,$4,$5,$6)', [workspace, member, 'Fixture member', `${member}@example.invalid`, 'member', 'active'])
    // A Team attachment never transfers the existing personal task. Create a
    // separate shared task in its own tenant before testing grouping/assignment.
    const revision = (await pool.query('SELECT revision FROM issues WHERE id=$1', [id])).rows[0].revision
    const crossRequestId = randomUUID()
    const beforeTransfer = (await pool.query('SELECT * FROM issues WHERE id=$1', [id])).rows[0]
    const crossWorkspace = await withActivitySession(owner, () => promoteIssueToTeam({ requestId: crossRequestId, issueId: id, revision, teamId: team, expectedTeamId: null }), ownCoordinator.workspaceId)
    assert.deepEqual(crossWorkspace, { error: 'teamIssueAccessDenied', requestId: crossRequestId })
    assert.deepEqual((await pool.query('SELECT * FROM issues WHERE id=$1', [id])).rows[0], beforeTransfer)
    assert.equal((await pool.query('SELECT count(*)::int n FROM team_issue_promotions WHERE "requestId"=$1', [crossRequestId])).rows[0].n, 0)
    assert.equal((await pool.query('SELECT count(*)::int n FROM mikka_team_issues WHERE "issueId"=$1', [id])).rows[0].n, 0)
    const shared = await inWorkspace(owner, workspace, () => createIssueAction(owner, { title: 'Shared assignment fixture' }, actor, `shared-${randomUUID()}`))
    assert.ok('id' in shared, JSON.stringify(shared))
    const sharedId = shared.id
    assert.deepEqual((await pool.query('SELECT "workspaceId","ownershipState",scope FROM issues WHERE id=$1', [sharedId])).rows, [{ workspaceId: workspace, ownershipState: 'bound', scope: 'workspace' }])
    await pool.query('INSERT INTO issue_members ("issueId","userId","memberId") VALUES ($1,$2,$3)', [sharedId, owner, stranger])
    const sharedRevision = (await pool.query('SELECT revision FROM issues WHERE id=$1', [sharedId])).rows[0].revision
    const promotion = await withActivitySession(owner, () => promoteIssueToTeam({ requestId: randomUUID(), issueId: sharedId, revision: sharedRevision, teamId: team, expectedTeamId: null }), workspace)
    assert.ok('issue' in promotion && promotion.issue, JSON.stringify(promotion))
    assert.equal(promotion.issue.scope, 'workspace')
    assert.equal(promotion.issue.linearSyncBlocked, true)
    assert.equal(promotion.issue.workspaceId, workspace)
    const [humanVersion] = (await pool.query('SELECT id,actor_type,actor_id FROM issue_versions WHERE "issueId"=$1 AND revision=$2', [sharedId, promotion.issue.revision])).rows
    assert.deepEqual({ type: humanVersion.actor_type, id: humanVersion.actor_id }, { type: 'user', id: owner })
    const updateShared = (changes: Omit<Parameters<typeof updateIssueAction>[1], 'issueId'>, toolCallId: string, userId = owner) => inWorkspace(userId, workspace, () => updateIssueAction(userId, { issueId: sharedId, ...changes }, actor, toolCallId))
    assert.ok('id' in await updateShared({ assigneeUserId: stranger }, `active-assignee-${randomUUID()}`), 'currently accessible human members remain assignable')
    await unchanged(() => updateIssue(owner, { issueId: sharedId, title: 'Wrong personal credential' }, actor, `wrong-personal-${randomUUID()}`), sharedId, 'issueNotFound')
    await unchanged(() => inWorkspace(owner, workspace, () => updateIssueAction(owner, { issueId: id, title: 'Wrong shared credential' }, actor, `wrong-shared-${randomUUID()}`)), id, 'issueNotFound')
    await unchanged(() => inWorkspace(owner, workspace, () => createIssueAction(owner, { ...input }, actor, callId)), id, 'issueNotFound')
    await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace, stranger])
    await unchanged(() => updateShared({ assigneeUserId: stranger }, `suspended-assignee-${randomUUID()}`), sharedId)
    await unchanged(() => updateShared({ title: 'Suspended member must not write' }, `suspended-actor-${randomUUID()}`, stranger), sharedId, 'workspaceAccessDenied')
    await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [workspace, stranger])
    await unchanged(() => updateShared({ assigneeUserId: stranger }, `removed-assignee-${randomUUID()}`), sharedId)
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
    type Receipt=import('../lib/factory/public-receipt').FactoryActionReceipt
    const invoke=factoryTools.intake_factory_request!.execute! as unknown as (input:unknown,options:{toolCallId:string;messages:never[];context:object})=>Promise<Receipt|{error:string}>
    const issueCount=await count('issues')
    const routed=await settledValues(Array.from({length:10},(_,n)=>invoke({...request,sourceEventId:n%2?sourceId.toUpperCase():sourceId},{toolCallId:`attempt-${n}`,messages:[],context:{}})))
    for(const result of routed){
      assert.ok('binding' in result,JSON.stringify(result));assert.equal(result.contractVersion,2)
      assert.equal('task' in result,false);assert.equal('attempts' in result,false);assert.equal('candidates' in result,false)
      assert.deepEqual(result,routed[0],'concurrent intake replays return the same frozen public receipt')
      assert.deepEqual(result.readTask,{tool:'get_factory_task',input:{taskId:result.binding.taskId}})
    }
    assert.equal(new Set(routed.map(result=>'binding' in result?result.binding.taskId:null)).size,1)
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
    // An installation row an earlier build recorded; admission no longer reads it (decision 2026-11-02-1600).
    await recordPushGrant(pool, owner, repository.key)
    // The Factory picks the run's model from 优先使用的模型, in the Coordinator bot's workspace.
    process.env.MIKKA_BYOS_ENABLED = '1'
    const botWorkspace = (await pool.query('SELECT "workspaceId" FROM bots WHERE id=$1', [coordinator])).rows[0].workspaceId
    await seedAllowedModel(pool, owner, { workspaceId: botWorkspace, deviceIds: [device] })
    const lifecycleTools=createCoordinatorRegistry(owner,coordinator,undefined,{coordinator:true})
    const first=routed[0];assert.ok('binding' in first)
    const dispatch=lifecycleTools.dispatch_factory_task!.execute! as unknown as (input:unknown,options:{toolCallId:string;messages:never[];context:object})=>Promise<Receipt|{error:string}>
    const dispatchInput={binding:first.binding,agentId:worker,deviceRepoId:repo}
    const executions=await settledValues(Array.from({length:10},(_,n)=>dispatch(dispatchInput,{toolCallId:`dispatch-${n}`,messages:[],context:{}})))
    for(const execution of executions){
      assert.ok('runId' in execution,JSON.stringify(execution));assert.equal(execution.contractVersion,2)
      assert.equal('task' in execution,false);assert.equal('attempts' in execution,false);assert.equal('candidates' in execution,false)
      assert.equal(execution.binding.taskId,first.binding.taskId);assert.equal(execution.binding.attemptId,first.binding.attemptId)
    }
    assert.equal(new Set(executions.map(r=>'runId' in r?r.runId:null)).size,1)
    const frozen=(await pool.query('SELECT * FROM agent_runs WHERE "issueId"=$1',[first.binding.issueId])).rows
    assert.equal(frozen.length,1);assert.equal(frozen[0].agentDefinition.kind,'worker')
    assert.equal(frozen[0].workspaceId,ownCoordinator.workspaceId)
    assert.equal((await pool.query('SELECT "workspaceId" FROM factory_tasks WHERE id=$1',[first.binding.taskId])).rows[0].workspaceId,ownCoordinator.workspaceId)
    assert.equal(frozen[0].agentDefinition.harness,'codex');assert.equal(frozen[0].status,'queued')
    assert.equal(frozen[0].agentDefinition.repositoryAdmission.remoteKey,repository.key)
    assert.deepEqual((await pool.query('SELECT "runId","remoteKey","pushApproved" FROM run_publications WHERE "issueId"=$1',[first.binding.issueId])).rows,[{runId:frozen[0].id,remoteKey:repository.key,pushApproved:true}])
    const replay=await dispatch(dispatchInput,{toolCallId:'exact-retry',messages:[],context:{}})
    assert.ok('runId' in replay);assert.equal(replay.runId,frozen[0].id);assert.equal(replay.replayed,true)
    const readOptions={toolCallId:'read-flow',messages:[],context:{}}
    const view=await lifecycleTools.get_factory_task!.execute!({taskId:first.binding.taskId},readOptions) as Awaited<ReturnType<typeof import('../lib/factory/public-task').readFactoryTaskView>>
    assert.equal(view.contractVersion,2);if(view.contractVersion!==2)assert.fail('normal tool must expose v2')
    assert.equal(view.task.stage,'implement');assert.equal('status' in view.task,false);assert.equal('route' in view.task,false)
    assert.deepEqual(view.binding,replay.binding);assert.equal(view.attempts[0].runId,frozen[0].id)
    const context=await lifecycleTools.get_issue!.execute!({issueId:first.binding.issueId},readOptions) as {status:string;factory:{tasks:import('../lib/factory/public-task').FactoryPublicTaskSummary[]}}
    assert.equal(context.status,(await pool.query('SELECT status FROM issues WHERE id=$1',[first.binding.issueId])).rows[0].status,'the issue keeps its own native status')
    assert.equal(context.factory.tasks.length,1);assert.equal(context.factory.tasks[0].stage,view.task.stage)
    assert.deepEqual(context.factory.tasks[0].binding,view.binding);assert.equal('status' in context.factory.tasks[0],false)
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
