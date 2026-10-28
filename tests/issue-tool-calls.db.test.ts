import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

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
  const { systemActor } = await import('../lib/activity-actor')
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
    await pool.query('insert into agents (id,"userId",harness,name) values ($1,$2,\'codex\',\'Legacy fixture\')', [legacyAgent, stranger])
    process.env.MIKKA_ISSUE_TOOLS_ENABLED = '0'
    const legacy = await createIssue(stranger, { title: 'Existing MCP path without rollout', assigneeAgentId: null }, actor)
    assert.ok('id' in legacy)
    const assigned = await updateIssue(stranger, { issueId: legacy.id, assigneeAgentId: legacyAgent }, actor)
    assert.ok('id' in assigned, 'the pre-existing MCP agent assignment remains accepted')
    assert.equal(assigned.assignee, 'Legacy fixture')
    assert.ok('id' in await updateIssue(stranger, { issueId: legacy.id, assigneeAgentId: null }, actor), 'the pre-existing MCP agent field remains accepted')
    assert.deepEqual(await createIssue(stranger, { title: 'Ambiguous', assigneeAgentId: null, assigneeUserId: stranger }, actor), { error: 'validationGeneric' })
    assert.deepEqual(await createIssue(stranger, { title: 'Queued step after shutdown' }, actor, `disabled-${randomUUID()}`), { error: 'issueToolsDisabled' })
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM issue_tool_calls WHERE "userId"=$1', [stranger])).rows[0].n, 0, 'disabled rollout preserves legacy MCP behavior without a receipt dependency')
    process.env.MIKKA_ISSUE_TOOLS_ENABLED = '1'
    // The actual registered Workflow tool invokes its scoped step and shared
    // actions. No test-only issue writer stands in for the Coordinator.
    const tools = createCoordinatorRegistry(owner, null)
    const create = () => tools.create_issue!.execute!(input, { toolCallId: callId, messages: [], context: {} })
    const results = await Promise.all([create(), create()])
    assert.ok('id' in results[0], JSON.stringify(results[0]))
    assert.deepEqual(results[0], results[1])
    assert.equal(await count('issues'), 1)
    assert.equal(await count('issue_tool_calls'), 1)
    const id = results[0].id as string
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
    await pool.query('UPDATE issues SET scope=\'workspace\' WHERE id=$1', [id])
    assert.ok('id' in await updateIssue(owner, { issueId: id, assigneeUserId: stranger }, actor, `active-assignee-${randomUUID()}`), 'currently accessible human members remain assignable')
    await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspace, stranger])
    await unchanged(() => updateIssue(owner, { issueId: id, assigneeUserId: stranger }, actor, `suspended-assignee-${randomUUID()}`))
    await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2', [workspace, stranger])
    await unchanged(() => updateIssue(owner, { issueId: id, assigneeUserId: stranger }, actor, `removed-assignee-${randomUUID()}`))

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
    assert.equal((await pool.query('select count(*) from issue_versions where "userId"=$1 and actor_type=\'system\' and actor_id=\'coordinator\'', [owner])).rows[0].count, String(await count('issue_versions')))
  } finally {
    await pool.query('DELETE FROM issue_members WHERE "userId"=$1', [owner])
    await pool.query('DELETE FROM mikka_team_issues WHERE "workspaceId"=$1', [workspace])
    await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1', [workspace])
    await pool.query('DELETE FROM mikka_teams WHERE id=$1', [team])
    await pool.query('DELETE FROM mikka_workspaces WHERE id=$1', [workspace])
    for (const id of [owner, stranger]) {
      for (const table of ['issue_tool_calls', 'issue_versions', 'issues']) await pool.query(`delete from ${table} where "userId"=$1`, [id])
      await pool.query('delete from agents where "userId"=$1', [id])
      await pool.query('delete from "user" where id=$1', [id])
    }
    await pool.end()
    const workspacePool = (globalThis as { workspacePool?: { end(): Promise<void> } }).workspacePool
    if (workspacePool) await workspacePool.end()
  }
})
