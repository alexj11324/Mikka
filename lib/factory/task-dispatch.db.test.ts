import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { after, afterEach, mock, test } from 'node:test'
import { Pool } from 'pg'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { workspaces, workspaceMembers } from '../db/workspace-schema'
import { organizationWorkspaces } from '../db/governance-schema'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { seedFixtureWorkspace } from '../../tests/helpers/task-workspace'

type ScopeFixture = { owner: string; workspaceId: string; depth: number; memberActive: boolean; exists: boolean; order: string[] }
type FixtureWhere = { where(condition: SQL): { for(mode: string, options?: { of: unknown }): Promise<Record<string, unknown>[]> } }
let scopeFixture: ScopeFixture | null = null
const compact = (sql: string) => sql.replace(/\s+/g, ' ').trim()
const dialect = new PgDialect()
const workspaceModule = await import('../workspace-db')

// Keep the real background boundary, membership checks and resource lease.
// Only the three source-only lock cases replace their persistence operations;
// the PG case below uses the real Workspace module and real tenant/member rows.
async function fixtureWorkspaceTransaction<T>(work: (tx: {
  select(fields: Record<string, unknown>): { from(table: unknown): FixtureWhere & { leftJoin(table: unknown, condition: SQL): FixtureWhere } }
  execute(statement: SQL): Promise<ReturnType<typeof select>>
}) => Promise<T>) {
  const scope = scopeFixture!
  const depth = ++scope.depth
  assert.ok(depth <= 2, 'only the membership owner and its nested resource lease open Workspace transactions')
  scope.order.push(`WS${depth} begin`)
  let workspaceRead = false, memberRead = false, relationLocked = false, resourceLocked = false, committed = false
  try {
    const result = await work({
      select: fields => ({ from: table => {
        let joined = false
        const where: FixtureWhere['where'] = condition => ({ for: async (mode, options) => {
          assert.equal(mode, 'share')
          const query = dialect.sqlToQuery(condition)
          if (table === workspaces) {
            assert.equal(joined, false); assert.equal(options, undefined)
            assert.deepEqual(Object.keys(fields), ['id', 'kind', 'ownerId'])
            assert.equal(fields.id, workspaces.id); assert.equal(fields.kind, workspaces.kind); assert.equal(fields.ownerId, workspaces.userId)
            assert.equal(compact(query.sql), '"mikka_workspaces"."id" = $1')
            assert.deepEqual(query.params, [scope.workspaceId])
            assert.equal(workspaceRead, false); workspaceRead = true
            scope.order.push(`WS${depth} workspace`)
            return [{ id: scope.workspaceId, kind: 'team', ownerId: scope.owner }]
          }
          assert.equal(table, workspaceMembers)
          assert.equal(joined, true)
          assert.deepEqual(Object.keys(options ?? {}), ['of']); assert.equal(options?.of, workspaceMembers)
          assert.deepEqual(Object.keys(fields), ['id', 'organizationId']); assert.equal(fields.id, workspaceMembers.userId)
          assert.equal(fields.organizationId, organizationWorkspaces.organizationId)
          assert.equal(compact(query.sql), '("mikka_workspace_members"."workspaceId" = $1 and "mikka_workspace_members"."userId" = $2 and "mikka_workspace_members"."status" = $3)')
          assert.deepEqual(query.params, [scope.workspaceId, scope.owner, 'active'])
          assert.equal(workspaceRead, true); assert.equal(memberRead, false); memberRead = true
          scope.order.push(`WS${depth} member`)
          return scope.memberActive ? [{ id: scope.owner, organizationId: null }] : []
        } })
        return { where, leftJoin: (joinedTable, condition) => {
          assert.equal(table, workspaceMembers); assert.equal(joinedTable, organizationWorkspaces); assert.equal(joined, false)
          const query = dialect.sqlToQuery(condition)
          assert.equal(compact(query.sql), '"mikka_organization_workspaces"."workspaceId" = "mikka_workspace_members"."workspaceId"')
          assert.deepEqual(query.params, []); joined = true
          return { where }
        } }
      } }),
      execute: async statement => {
        assert.equal(depth, 2); assert.equal(memberRead, true); assert.equal(scope.memberActive, true)
        const query = dialect.sqlToQuery(statement)
        if (compact(query.sql) === "select pg_advisory_xact_lock_shared(hashtextextended('mikka-team-relations',0))") {
          assert.deepEqual(query.params, []); assert.equal(relationLocked, false); relationLocked = true
          scope.order.push('WS relation')
        } else {
          assert.equal(compact(query.sql), 'select pg_advisory_xact_lock_shared(hashtextextended($1,0))')
          assert.deepEqual(query.params, [`project-resources:${scope.workspaceId}`])
          assert.equal(relationLocked, true); assert.equal(resourceLocked, false); resourceLocked = true
          scope.order.push('WS resources')
        }
        return select([])
      },
    })
    committed = true
    return result
  } finally {
    scope.order.push(`WS${depth} ${committed ? 'commit' : 'rollback'}`)
    scope.depth--
  }
}
mock.module(new URL('../workspace-db.ts', import.meta.url).href, { namedExports: {
  ...workspaceModule,
  workspaceDb: new Proxy(workspaceModule.workspaceDb, { get(target, key) {
    if (scopeFixture) {
      assert.equal(key, 'transaction', 'unit dispatch must use the transactional Workspace boundary')
      return fixtureWorkspaceTransaction
    }
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  } }),
} })

let locked: () => Promise<void> = async () => {}
mock.module(new URL('./runtime.ts', import.meta.url).href, { namedExports: {
  factoryLifecycleEnabled: () => true,
  factoryRuntimeForBot: () => ({ store: { lockTask: async () => { await locked() } } }),
} })
const { queueFactoryTask } = await import('./task-dispatch')
const { requireProjectResourceLease } = await import('../project-resources/store')
const { pool: applicationPool } = await import('../db')
afterEach(() => { if (scopeFixture) assert.equal(scopeFixture.depth, 0); scopeFixture = null })
after(async () => { mock.restoreAll(); await Promise.all([applicationPool.end(), workspaceModule.workspacePool.end()]) })
const input = () => ({ issueId: randomUUID(), botId: null, agentId: randomUUID(), deviceRepoId: randomUUID(), key: randomUUID(), queue: async () => { assert.fail('a durable replay cannot enqueue') } })
const select = (rows: Record<string, unknown>[]) => ({ command: 'SELECT', rows, rowCount: rows.length, fields: [] })
const receipt = () => select([{ same: true, status: 'pending', taskId: randomUUID(), result: { runId: 'already-queued' } }])
const isLock = (sql: string) => sql.startsWith('SELECT pg_advisory_xact_lock')
function fixture(response?: unknown, failure?: Error) {
  const request = input()
  const scope: ScopeFixture = { owner: 'owner', workspaceId: randomUUID(), depth: 0, memberActive: true, exists: true, order: [] }
  scopeFixture = scope
  const calls: { sql: string; parameters: unknown[][] }[] = []
  let released = 0
  const client = {
    query: async (sql: string, ...parameters: unknown[][]) => {
      calls.push({ sql, parameters })
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] }
      if (isLock(sql)) {
        if (failure) throw failure
        if (response !== undefined) return response
        const one = select([{ pg_advisory_xact_lock: '' }])
        return sql.includes(';') ? [one, one] : one
      }
      if (sql.startsWith('SELECT e.result')) return receipt()
      assert.fail('unexpected query')
    },
    release: () => { released++ },
  }
  return { pool: {
    query: async (sql: string, parameters: unknown[]) => {
      assert.equal(compact(sql), `SELECT i."workspaceId" FROM issues i WHERE i.id=$1 AND i."ownershipState"='bound' AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM bots b WHERE b.id=$3 AND b."ownerId"=$2 AND b."workspaceId"=i."workspaceId" AND b."archivedAt" IS NULL))`)
      assert.deepEqual(parameters, [request.issueId, scope.owner, request.botId])
      assert.equal(scope.depth, 0); assert.equal(calls.length, 0)
      scope.order.push('APP preflight')
      return select(scope.exists ? [{ workspaceId: scope.workspaceId }] : [])
    },
    connect: async () => {
      assert.equal(scope.depth, 2)
      requireProjectResourceLease(scope.owner, scope.workspaceId)
      scope.order.push('APP connect')
      return client
    },
  } as unknown as Pool, request, scope, calls, released: () => released }
}

test('host dispatch acquires both existing locks in one ordered round trip, with BEGIN separate', async () => {
  const f = fixture()
  locked = async () => {}
  assert.deepEqual(await queueFactoryTask(f.pool, 'owner', f.request), { runId: 'already-queued' })
  assert.deepEqual(f.scope.order.slice(0, 10), ['APP preflight', 'WS1 begin', 'WS1 workspace', 'WS1 member', 'WS2 begin', 'WS2 workspace', 'WS2 member', 'WS relation', 'WS resources', 'APP connect'])
  assert.equal(f.calls[0].sql, 'BEGIN')
  const locks = f.calls.filter(call => isLock(call.sql))
  assert.equal(locks.length, 1)
  assert.equal(locks[0].parameters.length, 0, 'native results require the simple protocol')
  assert.ok(locks[0].sql.indexOf('factory-host-dispatch') < locks[0].sql.lastIndexOf('SELECT pg_advisory_xact_lock'))
  assert.equal(f.calls.at(-1)?.sql, 'COMMIT')
  assert.equal(f.released(), 1)
})

test('malformed lock result batches roll back before any receipt or task is read', async () => {
  const one = select([{ pg_advisory_xact_lock: '' }])
  for (const result of [one, [one], [one, one, one], [{ ...one, command: 'UPDATE' }, one], [{ ...one, rows: [] }, one], [{ ...one, rows: [null] }, one]]) {
    const f = fixture(result)
    locked = async () => { assert.fail('task authorization must not run after an incomplete lock batch') }
    await assert.rejects(queueFactoryTask(f.pool, 'owner', f.request), /Invalid Factory dispatch locks/)
    assert.equal(f.calls.filter(call => call.sql.startsWith('SELECT e.result')).length, 0)
    assert.equal(f.calls.at(-1)?.sql, 'ROLLBACK')
    assert.equal(f.released(), 1)
  }
})

test('a failed lock query preserves its cause and never reads a replay receipt', async () => {
  const failure = new Error('fixture lock failure')
  const f = fixture(undefined, failure)
  await assert.rejects(queueFactoryTask(f.pool, 'owner', f.request), error => error === failure)
  assert.equal(f.calls.filter(call => call.sql.startsWith('SELECT e.result')).length, 0)
  assert.equal(f.calls.at(-1)?.sql, 'ROLLBACK')
  assert.equal(f.released(), 1)
})

test('Workspace preflight and current membership reject before any APP lock or replay receipt', async () => {
  for (const unavailable of ['issue', 'membership']) {
    const f = fixture()
    if (unavailable === 'issue') f.scope.exists = false
    else f.scope.memberActive = false
    await assert.rejects(queueFactoryTask(f.pool, 'owner', f.request), { code: 'factoryNotFound' })
    assert.deepEqual(f.calls, [])
    assert.equal(f.released(), 0)
    assert.equal(f.scope.depth, 0)
  }
})

const dbURL = disposableDatabase() ? process.env.E2E_DATABASE_URL : undefined
if (process.env.REQUIRE_DB === '1') assert.ok(dbURL, 'actual isolated PostgreSQL is required')

test('PG: quoted lock keys retain ordering, block their peers until commit, and release afterward', { skip: !dbURL, timeout: 10000 }, async () => {
  const parsed = new URL(dbURL!)
  assert.equal(parsed.hostname, '127.0.0.1')
  const pool = new Pool({ connectionString: dbURL, max: 4 })
  const runner = await pool.connect(), blocker = await pool.connect(), observer = await pool.connect()
  const owner = "owner'\\; SELECT 'not SQL' --" + randomUUID()
  const request = input()
  const keys = [JSON.stringify(['factory-host-dispatch', owner, request.issueId]), JSON.stringify([owner, request.issueId])]
  const calls: string[] = []
  let pending: Promise<{ runId: string }> | undefined
  let workspaceId: string | undefined
  try {
    assert.equal(scopeFixture, null, 'the PostgreSQL case uses the real Workspace implementation')
    await pool.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,now(),now())', [owner, 'Dispatch lock fixture', `${randomUUID()}@example.invalid`])
    workspaceId = await seedFixtureWorkspace(workspaceModule.workspacePool, owner, 'team')
    await pool.query(`INSERT INTO issues(id,"userId","workspaceId","ownershipState",scope,title,content,status,priority)
      VALUES($1,$2,$3,'bound','workspace','Dispatch lock fixture','{"type":"doc"}','todo','normal')`, [request.issueId, owner, workspaceId])
    const pid = (await runner.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
    await blocker.query('BEGIN')
    await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [keys[1]])
    const wrapped = new Proxy(runner, { get(target, key) {
      if (key === 'query') return async (sql: string, ...args: unknown[]) => {
        calls.push(sql)
        if (sql.startsWith('SELECT e.result')) return receipt()
        return Reflect.apply(target.query, target, [sql, ...args])
      }
      if (key === 'release') return () => {}
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    } })
    locked = async () => {
      const { rows } = await observer.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired', [keys[0]])
      assert.equal(rows[0].acquired, false)
    }
    pending = queueFactoryTask({
      query: pool.query.bind(pool),
      connect: async () => { requireProjectResourceLease(owner, workspaceId!); return wrapped },
    } as unknown as Pool, owner, request)
    pending.catch(() => {})
    const deadline = Date.now() + 2000
    let waiting = false
    while (Date.now() < deadline) {
      const { rows: [state] } = await observer.query('SELECT count(*) FILTER (WHERE granted)::int AS held,count(*) FILTER (WHERE NOT granted)::int AS waiting FROM pg_locks WHERE pid=$1 AND locktype=$2', [pid, 'advisory'])
      if (state.held === 1 && state.waiting === 1) { waiting = true; break }
      await delay(5)
    }
    assert.equal(waiting, true, 'the first lock is held while waiting for the second')
    for (const key of ['mikka-team-relations', `project-resources:${workspaceId}`]) {
      const held = await workspaceModule.workspacePool.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired', [key])
      assert.equal(held.rows[0].acquired, false, 'Workspace relation/resource locks precede and survive the waiting APP locks')
    }
    await blocker.query('COMMIT')
    assert.deepEqual(await pending, { runId: 'already-queued' })
    assert.equal(calls.filter(isLock).length, 1)
    for (const key of keys) assert.equal((await observer.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired', [key])).rows[0].acquired, true)
  } finally {
    await blocker.query('ROLLBACK').catch(() => {})
    await pending?.catch(() => {})
    await runner.query('ROLLBACK').catch(() => {})
    runner.release(); blocker.release(); observer.release()
    await pool.query('DELETE FROM issues WHERE id=$1', [request.issueId])
    if (workspaceId) await workspaceModule.workspacePool.query('DELETE FROM mikka_workspaces WHERE id=$1', [workspaceId])
    await pool.query('DELETE FROM "user" WHERE id=$1', [owner])
    await pool.end()
    locked = async () => {}
  }
})
