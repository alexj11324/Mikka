import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { Pool } from 'pg'
import { orderMigrations } from '../scripts/migration-order.mjs'
import { isE2eTarget, E2E_DB_RULE } from './helpers/e2e-target.mjs'
import { dropTestDatabase } from './support/drop-test-database'

const url = process.env.E2E_DATABASE_URL
if (url) assert.ok(isE2eTarget(url), E2E_DB_RULE)
else if (process.env.REQUIRE_DB === '1') assert.fail('REQUIRE_DB=1 needs an isolated E2E_DATABASE_URL')

test('real PostgreSQL fences the borrowed hosted drain, member removal, rollback and original private history', { skip: !url, timeout: 180_000 }, async () => {
  const admin = new Pool({ connectionString: url, max: 1 })
  const database = `hosted_revocation_${randomUUID().replaceAll('-', '')}_e2e`
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`)
  const target = new URL(url!); target.pathname = `/${database}`
  const pool = new Pool({ connectionString: target.toString(), max: 3 })
  try {
    const directory = new URL('../drizzle/', import.meta.url)
    for (const migration of orderMigrations((await readdir(directory)).filter(name => name.endsWith('.sql')))) await pool.query(await readFile(new URL(migration, directory), 'utf8'))
    const [{ AgentKitStore }, { DEFAULT_AGENT_DEFINITION }, { hostedExecutionsForRevocation, stopHostedExecutions }] = await Promise.all([
      import('../lib/agent-kit/store'), import('../lib/agent-kit/builtin'), import('../lib/hosted-execution-revocation'),
    ])
    const store = new AgentKitStore(pool)
    for (const user of ['owner', 'member']) await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())', [user, `${user}@example.invalid`])
    const workspace = randomUUID(), otherWorkspace = randomUUID(), connection = randomUUID()
    for (const id of [workspace, otherWorkspace]) await pool.query('INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES($1,\'owner\',\'Fixture workspace\',\'team\')', [id])
    const create = async (ownerId: string, credentialOwner: string, workspaceId = workspace) => {
      const botId = randomUUID(), holder = `wrun_${randomUUID()}`
      await pool.query('INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,$2,$3,\'Fixture Bot\')', [botId, ownerId, workspaceId])
      const runtime = { harness: 'ai_sdk', model: 'synthetic-model', actorId: ownerId, modelSelection: {
        type: 'subscription' as const, ownerId: credentialOwner, actorId: ownerId, consumerId: botId, workspaceId,
        bindingId: randomUUID(), connectionId: connection, connectionRevision: 1, modelId: 'synthetic-model', route: 'claude_cpa' as const,
        ...(ownerId === credentialOwner ? {} : { runOwnerId: ownerId }),
      } }
      const execution = await store.beginExecution({ ownerId, botId, workspaceId }, `${holder}:0`, 'synthetic-private-instructions', runtime, DEFAULT_AGENT_DEFINITION)
      await pool.query('INSERT INTO coordinator_sessions("userId","botId","leaseHolder","leaseUntil") VALUES($1,$2,$3,now()+interval \'1 hour\')', [ownerId, botId, holder])
      return { botId, holder, execution, runtime }
    }
    const own = await create('owner', 'owner'), borrowed = await create('member', 'owner'), foreign = await create('member', 'owner', otherWorkspace)
    const group = randomUUID(), message = randomUUID()
    await pool.query('INSERT INTO conversations(id,"workspaceId",kind,title,"createdBy") VALUES($1,$2,\'group\',\'Fixture group\',\'owner\')', [group, workspace])
    await pool.query('INSERT INTO conversation_messages(id,"conversationId",position,"authorType","authorId",body) VALUES($1,$2,1,\'user\',\'member\',\'synthetic-private-body\')', [message, group])
    await pool.query('INSERT INTO group_turns("messageId","conversationId","userId",status,"modelSelections") VALUES($1,$2,\'member\',\'running\',$3)', [message, group, { [borrowed.botId]: borrowed.runtime }])
    const matches = await hostedExecutionsForRevocation(pool, { workspaceId: workspace, borrowedOnly: true })
    assert.deepEqual(matches.sessions.map(row => row.executionId), [borrowed.execution.id])
    assert.deepEqual(matches.groups.map(row => row.messageId), [message])
    assert.ok(!JSON.stringify(matches).includes('synthetic-private'), 'the revocation selector returns only identifiers')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const stopped = await stopHostedExecutions(client, { workspaceId: workspace, borrowedOnly: true })
      assert.deepEqual(stopped, { holders: [borrowed.holder], executionIds: [borrowed.execution.id], groupTurnIds: [message] })
      assert.equal((await client.query('SELECT status FROM agent_kit_executions WHERE id=$1', [borrowed.execution.id])).rows[0].status, 'failed')
      await client.query('ROLLBACK')
      assert.equal((await pool.query('SELECT status FROM agent_kit_executions WHERE id=$1', [borrowed.execution.id])).rows[0].status, 'running')
      assert.equal((await pool.query('SELECT status FROM group_turns WHERE "messageId"=$1', [message])).rows[0].status, 'running')
      await client.query('BEGIN')
      await stopHostedExecutions(client, { workspaceId: workspace, borrowedOnly: true })
      await client.query('COMMIT')
      assert.equal((await pool.query('SELECT status FROM group_turns WHERE "messageId"=$1', [message])).rows[0].status, 'failed')
      assert.deepEqual((await pool.query('SELECT id,status FROM agent_kit_executions WHERE id=ANY($1::uuid[]) ORDER BY id', [[own.execution.id, foreign.execution.id]])).rows.map(row => row.status), ['running', 'running'])
      assert.equal((await pool.query('SELECT body FROM conversation_messages WHERE id=$1', [message])).rows[0].body, 'synthetic-private-body')
      assert.deepEqual((await pool.query('SELECT snapshot FROM agent_kit_executions WHERE id=$1', [borrowed.execution.id])).rows[0].snapshot, borrowed.execution.snapshot)
      assert.deepEqual(await stopHostedExecutions(pool, { workspaceId: workspace, borrowedOnly: true }), { holders: [], executionIds: [], groupTurnIds: [] }, 'the completed drain is idempotent')
      await client.query('BEGIN')
      const departed = await stopHostedExecutions(client, { workspaceId: workspace, ownerId: 'owner' })
      assert.deepEqual(departed.executionIds, [own.execution.id])
      await client.query('COMMIT')
      assert.equal((await pool.query('SELECT status FROM agent_kit_executions WHERE id=$1', [foreign.execution.id])).rows[0].status, 'running')
    } finally { client.release() }
  } finally {
    await pool.end()
    await dropTestDatabase(admin, database)
    await admin.end()
  }
})
