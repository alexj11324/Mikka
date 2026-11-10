import assert from 'node:assert/strict'
import { before, mock, test } from 'node:test'
import type { PoolClient } from 'pg'
import { observeCommitEffects } from './db/commit-effects'
import { wakeTransport } from './workflow-wake'

const background: Promise<unknown>[] = []
mock.module(new URL('./background.ts', import.meta.url).href, { namedExports: {
  afterJob: (_label: string, run: () => Promise<unknown>) => { background.push(run()) },
} })
let revocation: typeof import('./hosted-execution-revocation')
before(async () => { revocation = await import('./hosted-execution-revocation') })
const executionId = '10000000-0000-4000-8000-000000000001'
const workspaceId = '10000000-0000-4000-8000-000000000002'

function fixture(present = true) {
  const statements: { sql: string; args: unknown[] }[] = []
  const client = { query: async (sql: string, args: unknown[] = []) => {
    statements.push({ sql, args })
    const rows = sql.startsWith('SELECT\n') ? [{ coordinators: present, groups: false }]
      : sql.startsWith('WITH active') ? [{ holder: 'wrun_synthetic', executionId, workspaceId }, { holder: 'wrun_synthetic', executionId, workspaceId }]
        : []
    return { rows, rowCount: rows.length, command: sql.trim().split(/\s/)[0].toUpperCase() }
  } } as unknown as PoolClient
  observeCommitEffects(client)
  return { client, statements }
}

test('a credential revocation stops each matching holder once only after the actual transaction commits', async t => {
  const { client, statements } = fixture(), wakes: string[] = []
  const previous = wakeTransport.resume
  wakeTransport.resume = async token => { wakes.push(token) }
  t.after(() => { wakeTransport.resume = previous })
  for (const outcome of ['ROLLBACK', 'COMMIT']) {
    await client.query('BEGIN')
    const result = await revocation.stopHostedExecutions(client, { workspaceId, subscriptionOwnerId: 'owner', borrowedOnly: true })
    assert.deepEqual(result, { holders: ['wrun_synthetic'], executionIds: [executionId], groupTurnIds: [] })
    assert.deepEqual(wakes, [])
    await client.query(outcome)
    await new Promise(resolve => setImmediate(resolve))
    await Promise.all(background)
    assert.deepEqual(wakes, outcome === 'COMMIT' ? ['coordinator-stop:wrun_synthetic'] : [])
  }
  const selection = statements.find(statement => statement.sql.startsWith('WITH active'))!
  assert.deepEqual(selection.args, [workspaceId, null, 'owner', null, null, true, null, false])
  assert.deepEqual(statements.filter(statement => statement.sql.startsWith('UPDATE agent_kit_executions')).map(statement => statement.args), [[ [executionId] ], [ [executionId] ]])
})

test('an unscoped stop is rejected before SQL; absent hosted tables have no sessions to stop', async () => {
  const { client, statements } = fixture(false)
  await assert.rejects(revocation.stopHostedExecutions(client, {}), /hosted_revocation_scope_required/)
  assert.equal(statements.length, 0)
  assert.deepEqual(await revocation.stopHostedExecutions(client, { ownerId: 'owner' }), { holders: [], executionIds: [], groupTurnIds: [] })
  assert.equal(statements.length, 1)
})
