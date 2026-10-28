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
  assert.equal(url.pathname, '/mikka_e2e')
  assert.equal(process.env.MIKKA_DATABASE_URL, connection)
}

test('actual issue actions commit one issue per tool call, roll back partial writes, and preserve history on replay', { skip: !enabled }, async () => {
  const { pool } = await import('../lib/db')
  const { createIssue, updateIssue } = await import('../lib/mcp/actions')
  const { createCoordinatorRegistry } = await import('../workflows/coordinator/tools')
  const { systemActor } = await import('../lib/activity-actor')
  const owner = `issue-tools-${randomUUID()}`
  const stranger = `issue-tools-${randomUUID()}`
  const callId = `create-${randomUUID()}`
  const actor = systemActor('coordinator')
  const input = { title: 'Repair the login flow', labels: ['regression'], assigneeUserId: owner }
  const count = async (table: string) => Number((await pool.query(`select count(*) from ${table} where "userId"=$1`, [owner])).rows[0].count)
  try {
    assert.equal((await pool.query('show server_version_num')).rows[0].server_version_num.slice(0, 2), '17')
    for (const id of [owner, stranger]) await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,false,now(),now())', [id, `${id}@example.invalid`])
    // The actual registered Workflow tool invokes its scoped step and shared
    // actions. No test-only issue writer stands in for the Coordinator.
    const tools = createCoordinatorRegistry(owner, null)
    const create = () => tools.create_issue.execute!(input, { toolCallId: callId, messages: [], context: {} })
    const results = await Promise.all([create(), create()])
    assert.ok('id' in results[0], JSON.stringify(results[0]))
    assert.deepEqual(results[0], results[1])
    assert.equal(await count('issues'), 1)
    assert.equal(await count('issue_tool_calls'), 1)
    const id = results[0].id as string
    const versions = await count('issue_versions')
    assert.deepEqual(await createIssue(owner, { ...input }, actor, callId), results[0])
    assert.equal(await count('issue_versions'), versions)
    assert.deepEqual(await createIssue(owner, { ...input, title: 'Different request' }, actor, callId), { error: 'issueToolCallConflict' })
    assert.equal(await count('issues'), 1)

    // The issue insert and its history must disappear if a later metadata write fails.
    assert.deepEqual(await createIssue(owner, { title: 'Must roll back', assigneeUserId: stranger }, actor, `invalid-${randomUUID()}`), { error: 'memberNotJoined' })
    assert.equal(await count('issues'), 1)
    assert.equal(await count('issue_versions'), versions)
    assert.equal(await count('issue_tool_calls'), 1)

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
    for (const id of [owner, stranger]) {
      for (const table of ['issue_tool_calls', 'issue_versions', 'issues']) await pool.query(`delete from ${table} where "userId"=$1`, [id])
      await pool.query('delete from "user" where id=$1', [id])
    }
    await pool.end()
  }
})
