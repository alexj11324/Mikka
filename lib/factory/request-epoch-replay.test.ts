import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import type { Pool } from 'pg'
import { PgDialect } from 'drizzle-orm/pg-core'

const sourceEventId = '00000000-0000-4000-8000-000000000001'
const taskId = '00000000-0000-4000-8000-000000000002'
const runId = '00000000-0000-4000-8000-000000000003'
const workspaceId = '00000000-0000-4000-8000-000000000004'
let status = 'running'
const task = () => ({ id: taskId, userId: 'owner', botId: null, issueId: 'issue',
  sourceEventId, stage: 'execute', status, route: { flowVersion: 2 } })

// Replay composition keeps the real background/Task Workspace guards. Only
// their closed DB projections and unrelated session/notification IO are fixtures;
// lock waits and persisted revocation are exercised by the PostgreSQL suites.
const dialect = new PgDialect()
const compact = (value: string) => value.replace(/\s+/g, ' ').trim()
const admittedLocks = ['workspace', 'member', 'workspace', 'member', 'relations', 'resources']
const tableName = (table: Record<symbol, unknown>) => table[Object.getOwnPropertySymbols(table).find(key => key.description === 'drizzle:Name')!]
let workspaceProbe: { memberAllowed: boolean; persistedWorkspaceId: string | null; depth: number; locks: string[] }
function workspaceSelect(columns: Record<string, unknown>) {
  let table: unknown, condition: ReturnType<PgDialect['sqlToQuery']>, organizationJoin = false
  const query = {
    from(value: Record<symbol, unknown>) { table = tableName(value); return query },
    leftJoin(value: Record<symbol, unknown>, predicate: Parameters<PgDialect['sqlToQuery']>[0]) {
      assert.equal(table, 'mikka_workspace_members')
      assert.equal(tableName(value), 'mikka_organization_workspaces')
      const join = dialect.sqlToQuery(predicate)
      assert.equal(join.sql, '"mikka_organization_workspaces"."workspaceId" = "mikka_workspace_members"."workspaceId"')
      assert.deepEqual(join.params, [])
      assert.deepEqual(Object.keys(columns), ['id', 'organizationId'])
      organizationJoin = true
      return query
    },
    where(value: Parameters<PgDialect['sqlToQuery']>[0]) { condition = dialect.sqlToQuery(value); return query },
    async for(mode: string, options?: { of?: Record<symbol, unknown> }) {
      assert.ok(workspaceProbe.depth > 0 && workspaceProbe.depth <= 2)
      assert.equal(mode, 'share')
      if (table === 'mikka_workspaces') {
        assert.deepEqual(Object.keys(columns), ['id', 'kind', 'ownerId'])
        assert.equal(compact(condition.sql), '"mikka_workspaces"."id" = $1')
        assert.deepEqual(condition.params, [workspaceId])
        assert.equal(workspaceProbe.locks.length, (workspaceProbe.depth - 1) * 2)
        workspaceProbe.locks.push('workspace')
        return [{ id: workspaceId, kind: 'team', ownerId: 'owner' }]
      }
      assert.equal(table, 'mikka_workspace_members')
      assert.equal(compact(condition.sql), '("mikka_workspace_members"."workspaceId" = $1 and "mikka_workspace_members"."userId" = $2 and "mikka_workspace_members"."status" = $3)')
      assert.deepEqual(condition.params, [workspaceId, 'owner', 'active'])
      assert.equal(workspaceProbe.locks.at(-1), 'workspace')
      if (organizationJoin) {
        assert.ok(options?.of)
        assert.equal(tableName(options.of), 'mikka_workspace_members')
      } else {
        assert.deepEqual(Object.keys(columns), ['id'])
        assert.equal(options, undefined)
      }
      workspaceProbe.locks.push('member')
      return workspaceProbe.memberAllowed ? [{ id: 'owner', ...(organizationJoin ? { organizationId: null } : {}) }] : []
    },
  }
  return query
}
async function workspaceExecute(statement: Parameters<PgDialect['sqlToQuery']>[0]) {
  assert.equal(workspaceProbe.depth, 2, 'resource locks belong to the nested Workspace lease')
  assert.equal(workspaceProbe.memberAllowed, true)
  const query = dialect.sqlToQuery(statement)
  if (compact(query.sql) === "select pg_advisory_xact_lock_shared(hashtextextended('mikka-team-relations',0))") {
    assert.deepEqual(query.params, [])
    assert.deepEqual(workspaceProbe.locks, admittedLocks.slice(0, 4))
    workspaceProbe.locks.push('relations')
  } else {
    assert.equal(compact(query.sql), 'select pg_advisory_xact_lock_shared(hashtextextended($1,0))')
    assert.deepEqual(query.params, [`project-resources:${workspaceId}`])
    assert.deepEqual(workspaceProbe.locks, admittedLocks.slice(0, 5))
    workspaceProbe.locks.push('resources')
  }
  return { rows: [], rowCount: 0 }
}
mock.module('../workspace-db.ts', { namedExports: {
  workspaceDb: { select: workspaceSelect, transaction: async <T>(work: (tx: { select: typeof workspaceSelect; execute: typeof workspaceExecute }) => Promise<T>) => {
    assert.ok(workspaceProbe.depth < 2, 'only the owner and its Project resource lease open Workspace transactions')
    workspaceProbe.depth++
    try { return await work({ select: workspaceSelect, execute: workspaceExecute }) } finally { workspaceProbe.depth-- }
  } },
  workspacePool: { query: async () => assert.fail('Replay fixture must not borrow an unrelated Workspace connection') },
} })
mock.module('../db/request-scope.ts', { namedExports: { inDatabaseTransaction: () => false } })
mock.module('../db/index.ts', { namedExports: {
  db: {}, pool: { query: async () => assert.fail('Replay fixture must not open an unrelated APP query') },
} })
mock.module('../session.ts', { namedExports: { getSession: async () => assert.fail('Owner replay must not look up a new browser session') } })
mock.module('../request-log.ts', { namedExports: { noteLogUser: () => {} } })
mock.module('../run-control.ts', { namedExports: { stopOwnedRun: async () => assert.fail('Accepted replay must not stop the current executor') } })
mock.module('../run-completion-effects.ts', { namedExports: { afterRunEnded: async () => assert.fail('Accepted replay must not invoke completion or reconciliation') } })

mock.module('../live/factory.ts', { namedExports: { factoryChanged: async () => {} } })
mock.module('../device-gateway-notify.ts', { namedExports: { runControlChanged: () => {} } })
mock.module('./runtime.ts', { namedExports: { factoryRuntimeForBot: () => ({ store: {
  lockTask: async (_tx: unknown, owner: string, id: string) => {
    assert.equal(owner, 'owner'); assert.equal(id, taskId)
    return task()
  },
} }) } })
const { continueActiveFactoryRequest } = await import('./request-epoch')
const { requireProjectResourceLease } = await import('../project-resources/store')

function fixture(allowEventWrite = false) {
  workspaceProbe = { memberAllowed: true, persistedWorkspaceId: workspaceId, depth: 0, locks: [] }
  const writes: string[] = [], boundaries: string[] = []
  let released = false, connections = 0
  const client = {
    async query(sql: string, params?: unknown[]) {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) {
        assert.equal(params, undefined)
        boundaries.push(sql)
        return { rows: [] }
      }
      if (sql.startsWith('SELECT e.payload FROM coordinator_events e WHERE e.id=$1')) {
        assert.equal(compact(sql), `SELECT e.payload FROM coordinator_events e WHERE e.id=$1 AND e."userId"=$2 AND e."botId" IS NOT DISTINCT FROM $3::uuid AND (e."issueId" IS NULL OR e."issueId"=$4) AND e.kind='user_message' AND EXISTS(SELECT 1 FROM agent_runs r WHERE r.id=$5 AND r."userId"=$2 AND r."issueId"=$4)`)
        assert.deepEqual(params, [sourceEventId, 'owner', null, 'issue', runId])
        return { rows: [{ payload: { text: 'The original accepted request' } }] }
      }
      if (sql.startsWith('INSERT INTO coordinator_events(id,"userId","botId","issueId",kind,"dedupeKey",payload,tier,"deliveredAt","createdAt")')) {
        assert.equal(compact(sql), `INSERT INTO coordinator_events(id,"userId","botId","issueId",kind,"dedupeKey",payload,tier,"deliveredAt","createdAt") SELECT $1,$2,$3,$4,'user_message',$5,$6,'background',now(),"createdAt" FROM coordinator_events WHERE id=$7 ON CONFLICT DO NOTHING`)
        assert.ok(params)
        assert.equal(params.length, 7)
        assert.match(String(params[0]), /^[0-9a-f-]{36}$/)
        assert.deepEqual(params.slice(1, 4), ['owner', null, 'issue'])
        assert.equal(params[4], `thread-source:${params[0]}`)
        assert.deepEqual(JSON.parse(String(params[5])), { text: 'The original accepted request', source: 'thread_continuation', previousRunId: runId, originEventId: sourceEventId, postedToChat: true })
        assert.equal(params[6], sourceEventId)
        writes.push(sql)
        assert.equal(allowEventWrite, true, 'Accepted owner event must not be promoted to a new epoch')
        return { rows: [] }
      }
      assert.fail('Unexpected storage query')
    },
    release() { released = true },
  }
  const pool = {
    async query(sql: string, params: unknown[]) {
      if (sql.startsWith('SELECT t.id,t."botId",t."issueId" FROM factory_attempts a')) {
        assert.deepEqual(params, [runId, 'owner'])
        return { rows: [{ id: taskId, botId: null, issueId: 'issue' }] }
      }
      assert.ok(sql.startsWith('SELECT t."workspaceId" FROM factory_tasks t'))
      assert.ok(sql.includes('JOIN issues i ON i.id=t."issueId" AND i."ownershipState"=\'bound\' AND i."workspaceId"=t."workspaceId"'))
      assert.ok(sql.includes('WHERE t.id=$1 AND t."userId"=$2'))
      assert.deepEqual(params, [taskId, 'owner', false, null])
      return { rows: [{ workspaceId: workspaceProbe.persistedWorkspaceId }] }
    },
    async connect() {
      assert.equal(workspaceProbe.depth, 2, 'APP checkout follows both real Workspace and resource leases')
      assert.deepEqual(workspaceProbe.locks, admittedLocks)
      requireProjectResourceLease('owner', workspaceId)
      connections++
      assert.equal(workspaceProbe.memberAllowed, true)
      return client
    },
  } as unknown as Pool
  return { pool, writes, boundaries, released: () => released, connections: () => connections }
}

test('forwarding the already accepted owner event keeps the current executor and request epoch', async () => {
  status = 'running'
  const f = fixture()
  assert.equal(await continueActiveFactoryRequest(f.pool, 'owner', runId,
    'Coordinator forwarding note does not create new user authority', sourceEventId), true)
  assert.deepEqual(f.writes, [])
  assert.deepEqual(f.boundaries, ['BEGIN', 'COMMIT'])
  assert.equal(f.released(), true)
  assert.deepEqual(workspaceProbe.locks, admittedLocks)
  assert.equal(workspaceProbe.depth, 0)
  assert.equal(f.connections(), 1)
  assert.throws(() => requireProjectResourceLease('owner', workspaceId), { code: 'projectEnvironmentUnavailable' })
})

test('replaying an accepted event cannot resume a cancelled or revoked task', async () => {
  for (status of ['cancelled', 'revoked']) {
    const f = fixture(true)
    await assert.rejects(continueActiveFactoryRequest(f.pool, 'owner', runId, 'Original request', sourceEventId), { code: 'factoryStopped' })
    assert.equal(f.boundaries.at(-1), 'ROLLBACK')
    assert.equal(f.released(), true)
    assert.equal(f.connections(), 1)
    assert.deepEqual(workspaceProbe.locks, admittedLocks)
    assert.equal(workspaceProbe.depth, 0)
  }
})

test('an accepted event still requires persisted tenant ownership and active membership', async () => {
  for (const missing of ['tenant', 'membership'] as const) {
    const f = fixture()
    status = 'running'
    if (missing === 'tenant') workspaceProbe.persistedWorkspaceId = null
    else workspaceProbe.memberAllowed = false
    await assert.rejects(continueActiveFactoryRequest(f.pool, 'owner', runId, 'Original request', sourceEventId), { code: 'factoryNotFound' })
    assert.deepEqual(f.writes, [])
    assert.deepEqual(f.boundaries, [], 'refusal happens before any APP transaction')
    assert.equal(f.released(), false)
    assert.equal(f.connections(), 0)
    assert.deepEqual(workspaceProbe.locks, missing === 'tenant' ? [] : ['workspace', 'member'])
    assert.equal(workspaceProbe.depth, 0)
  }
})
