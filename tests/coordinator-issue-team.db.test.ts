// A Coordinator creates in its host workspace, with optional Team grouping,
// through the real registered tool, step, action and receipt transactions.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { seedCoordinator } from './support/coordinator-bot'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { overrideDeploymentSwitch } from '../lib/deployment-switches'

const enabled = disposableDatabase()
if (process.env.REQUIRE_DB === '1' && !enabled) throw new Error('Coordinator team issue DB test requires a loopback *_e2e database')
if (enabled) overrideDeploymentSwitch('issueTools', true)

test('Coordinator tools keep personal, grouped and teamless shared tasks in their host workspace', { skip: !enabled }, async () => {
  const { pool } = await import('../lib/db')
  const { createCoordinatorRegistry } = await import('../workflows/coordinator/tools')
  const { coordinatorBot } = await import('../lib/coordinator/coordinator-bot')
  const owner = `issue-team-${randomUUID()}`
  const workspace = randomUUID(), teamlessWorkspace = randomUUID(), team = randomUUID(), other = randomUUID()
  const identifier = `AC${randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase()}`
  try {
    await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,false,now(),now())', [owner, `${owner}@example.invalid`])
    const personalCoordinator = await seedCoordinator(owner)
    const personal = personalCoordinator.botId
    await pool.query(`INSERT INTO mikka_workspaces (id,"userId",name,slug,kind) VALUES ($1,$2,'Acme',$3,'team')`, [workspace, owner, `acme-${workspace.slice(0, 8)}`])
    await pool.query(`INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,'admin','active')`, [workspace, owner, `${owner}@example.invalid`])
    await pool.query('INSERT INTO mikka_teams (id,"workspaceId","userId",name,identifier) VALUES ($1,$2,$3,$4,$5)', [team, workspace, owner, 'Acme', identifier])
    const acme = (await coordinatorBot(owner, workspace)).botId
    const create = (botId: string, input: Record<string, unknown>) => createCoordinatorRegistry(owner, botId, undefined, { coordinator: true }).create_issue!.execute!(input, { toolCallId: `call-${randomUUID()}`, messages: [], context: {} })

    const created = await create(acme, { title: 'Fix the Acme login', labels: ['bug'] })
    assert.ok('id' in created, JSON.stringify(created))
    const row = (await pool.query('SELECT scope,"workspaceId","ownershipState","linearSyncBlocked" FROM issues WHERE id=$1', [created.id])).rows[0]
    assert.equal(row.scope, 'workspace')
    assert.equal(row.workspaceId, workspace)
    assert.equal(row.ownershipState, 'bound')
    assert.deepEqual((await pool.query('SELECT "teamId","workspaceId" FROM mikka_team_issues WHERE "issueId"=$1', [created.id])).rows, [{ teamId: team, workspaceId: workspace }])
    assert.deepEqual(created.labels, ['bug'], 'the remaining fields still apply to the team task')
    const versions = (await pool.query('SELECT actor_type,actor_id FROM issue_versions WHERE "issueId"=$1 ORDER BY revision', [created.id])).rows
    assert.ok(versions.length > 0 && versions.every(version => version.actor_type === 'system' && version.actor_id === acme), 'history names the Coordinator bot, not the person')

    // The same tool call retried returns the same task.
    const callId = `call-${randomUUID()}`
    const tools = createCoordinatorRegistry(owner, acme, undefined, { coordinator: true })
    const once = await tools.create_issue!.execute!({ title: 'Retried' }, { toolCallId: callId, messages: [], context: {} })
    assert.deepEqual(await tools.create_issue!.execute!({ title: 'Retried' }, { toolCallId: callId, messages: [], context: {} }), once)

    // Several teams the person belongs to: the host asks which, then takes only one of them.
    await pool.query('INSERT INTO mikka_teams (id,"workspaceId","userId",name,identifier) VALUES ($1,$2,$3,$4,$5)', [other, workspace, owner, 'Design', `${identifier.slice(0, 6)}D`])
    const ambiguous = await create(acme, { title: 'Which team?' })
    assert.equal((ambiguous as { error?: string }).error, 'issueTeamRequired')
    assert.deepEqual((ambiguous as { teams: { id: string }[] }).teams.map(item => item.id).sort(), [team, other].sort())
    const chosen = await create(acme, { title: 'Design task', teamId: other })
    assert.ok('id' in chosen, JSON.stringify(chosen))
    assert.equal((await pool.query('SELECT "teamId" FROM mikka_team_issues WHERE "issueId"=$1', [chosen.id])).rows[0].teamId, other)
    assert.equal((await create(acme, { title: 'Foreign team', teamId: randomUUID() }) as { error?: string }).error, 'issueTeamRequired')

    // The personal workspace's Coordinator still creates a personal task.
    const own = await create(personal, { title: 'Personal errand' })
    assert.ok('id' in own, JSON.stringify(own))
    assert.deepEqual((await pool.query('SELECT scope,"workspaceId","ownershipState" FROM issues WHERE id=$1', [own.id])).rows, [{ scope: 'personal', workspaceId: personalCoordinator.workspaceId, ownershipState: 'bound' }])
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM mikka_team_issues WHERE "issueId"=$1', [own.id])).rows[0].n, 0)

    await pool.query(`INSERT INTO mikka_workspaces (id,"userId",name,slug,kind) VALUES ($1,$2,'Teamless shared',$3,'team')`, [teamlessWorkspace, owner, `teamless-${teamlessWorkspace}`])
    await pool.query(`INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$2,$3,'admin','active')`, [teamlessWorkspace, owner, `${owner}@example.invalid`])
    const teamless = (await coordinatorBot(owner, teamlessWorkspace)).botId
    const ungrouped = await create(teamless, { title: 'Shared task without Team grouping' })
    assert.ok('id' in ungrouped, JSON.stringify(ungrouped))
    assert.deepEqual((await pool.query('SELECT scope,"workspaceId","ownershipState" FROM issues WHERE id=$1', [ungrouped.id])).rows, [{ scope: 'workspace', workspaceId: teamlessWorkspace, ownershipState: 'bound' }])
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM mikka_team_issues WHERE "issueId"=$1', [ungrouped.id])).rows[0].n, 0)
    const snapshot = async () => ({
      issues: (await pool.query('SELECT id,title,content,revision,"workspaceId" FROM issues WHERE "userId"=$1 ORDER BY id', [owner])).rows,
      versions: (await pool.query('SELECT id FROM issue_versions WHERE "userId"=$1 ORDER BY id', [owner])).rows,
      receipts: (await pool.query('SELECT "toolCallId","issueId",result,effects FROM issue_tool_calls WHERE "userId"=$1 ORDER BY "toolCallId"', [owner])).rows,
      counter: (await pool.query('SELECT "lastIssueNumber" FROM "user" WHERE id=$1', [owner])).rows,
      teams: (await pool.query('SELECT "issueId","teamId","workspaceId" FROM mikka_team_issues WHERE "userId"=$1 ORDER BY "issueId"', [owner])).rows,
    })
    const beforeDenied = await snapshot()
    assert.deepEqual(await create(teamless, { title: 'Cannot borrow another workspace team', teamId: team }), { error: 'issueTeamRequired', teams: [] })
    const otherTools = createCoordinatorRegistry(owner, teamless, undefined, { coordinator: true })
    assert.deepEqual(await otherTools.update_issue!.execute!({ issueId: created.id, title: 'Cannot edit across workspaces' }, { toolCallId: `cross-${randomUUID()}`, messages: [], context: {} }), { error: 'issueNotFound' })
    assert.deepEqual(await snapshot(), beforeDenied, 'cross-workspace tool calls have no task, history, receipt, counter or Team-link side effects')
    await pool.query(`UPDATE mikka_workspace_members SET status='suspended' WHERE "workspaceId"=$1 AND "userId"=$2`, [workspace, owner])
    await assert.rejects(create(acme, { title: 'Suspended owner cannot create', teamId: team }), { code: 'workspaceAccessDenied' })
    await assert.rejects(tools.create_issue!.execute!({ title: 'Retried' }, { toolCallId: callId, messages: [], context: {} }), { code: 'workspaceAccessDenied' })
    assert.deepEqual(await snapshot(), beforeDenied, 'suspension also rejects a previously successful tool-call replay without writes')
    const stillActive = await create(teamless, { title: 'Other workspace remains active' })
    assert.ok('id' in stillActive, JSON.stringify(stillActive))
    assert.equal((await pool.query('SELECT "workspaceId" FROM issues WHERE id=$1', [stillActive.id])).rows[0].workspaceId, teamlessWorkspace)
  } finally {
    await pool.query('DELETE FROM mikka_team_issues WHERE "workspaceId"=$1', [workspace])
    await pool.query('DELETE FROM team_issue_create_receipts WHERE "workspaceId"=$1', [workspace])
    await pool.query('DELETE FROM mikka_teams WHERE "workspaceId"=$1', [workspace])
    await pool.query('DELETE FROM issue_tool_calls WHERE "userId"=$1', [owner])
    await pool.query('DELETE FROM team_issue_create_requests WHERE "ownerId"=$1', [owner])
    await pool.query('DELETE FROM issue_versions WHERE "userId"=$1', [owner])
    await pool.query('DELETE FROM issues WHERE "userId"=$1', [owner])
    await pool.query('DELETE FROM bots WHERE "ownerId"=$1', [owner])
    await pool.query('DELETE FROM mikka_workspace_members WHERE "userId"=$1', [owner])
    await pool.query('DELETE FROM mikka_workspaces WHERE "userId"=$1', [owner])
    await pool.end()
    const workspacePool = (globalThis as { workspacePool?: { end(): Promise<void> } }).workspacePool
    if (workspacePool) await workspacePool.end()
  }
})
