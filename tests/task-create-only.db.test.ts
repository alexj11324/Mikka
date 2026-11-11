import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { disposableDatabase } from './helpers/e2e-target.mjs'
import { withActivitySession } from './fixtures/activity-runtime.mjs'
import { seedCoordinator } from './support/coordinator-bot'
import type { CreateOnlyCommand } from '../lib/task-create-command'

const enabled = disposableDatabase()
if (process.env.REQUIRE_DB === '1' && !enabled) throw new Error('Task creation requires a disposable loopback database')

test('a create-only command has one durable Task receipt and no dispatch or inference', { skip: !enabled }, async () => {
  const { pool } = await import('../lib/db')
  const { createTaskOnly } = await import('../app/actions/issues')
  const { getTaskPresentation } = await import('../app/actions/task-domain')
  const user = `new-task-${randomUUID()}`, stranger = `new-task-${randomUUID()}`
  const insert = (id: string) => pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt")
    VALUES($1,$1,$2,true,now(),now())`, [id, `${id}@example.invalid`])
  await insert(user)
  await insert(stranger)
  try {
    const { workspaceId } = await seedCoordinator(user)
    const other = await seedCoordinator(stranger)
    const input: CreateOnlyCommand = { version: 1, intent: 'create_only', requestId: randomUUID(), workspaceId,
      title: 'Backlog task', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Write it later' }] }] },
      status: 'todo', priority: 'normal' }
    const send = (value: CreateOnlyCommand) => withActivitySession(user, () => createTaskOnly(value), workspaceId)
    const concurrent = await Promise.all(Array.from({ length: 4 }, () => send(input)))
    const result = concurrent[0]!
    assert.ok('taskId' in result, JSON.stringify(result))
    assert.ok(result.taskId && result.identifier)
    assert.equal(result.dispatch, null)
    for (const returned of concurrent) assert.deepEqual(returned, result)
    assert.deepEqual(await send(input), result)
    assert.equal((await send({ ...input, title: 'Different request' })).error, 'submissionConflict')
    assert.equal((await send({ ...input, workspaceId: other.workspaceId })).error, 'workspaceAccessDenied')
    const invalid = { ...input, requestId: randomUUID(), content: { type: 'unknown' } }
    assert.equal((await send(invalid)).error, 'issueCreateFailed')
    assert.equal((await pool.query('SELECT 1 FROM task_creation_receipts WHERE "requestId"=$1', [invalid.requestId])).rowCount, 0)
    const state = await withActivitySession(user, () => getTaskPresentation(result.taskId), workspaceId)
    assert.equal(state.state, 'todo')
    for (const table of ['issues', 'issue_versions', 'task_creation_receipts']) {
      assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE "userId"=$1`, [user])).rowCount, 1, table)
    }
    for (const table of ['coordinator_events', 'agent_runs', 'factory_tasks']) {
      assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE "userId"=$1 AND "issueId"=$2`, [user, result.taskId])).rowCount, 0, table)
    }
    await pool.query('DELETE FROM issues WHERE id=$1', [result.taskId])
    assert.equal((await send(input)).error, 'issueNotFound')
  } finally {
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [[user, stranger]])
  }
})
