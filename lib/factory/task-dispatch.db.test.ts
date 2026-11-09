import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { mock, test } from 'node:test'
import { Pool } from 'pg'
import { disposableDatabase } from '../../tests/helpers/e2e-target.mjs'
import { bindFixtureWorkspaceDatabase } from '../../tests/helpers/workspace-database'
import { seedFixtureWorkspace } from '../../tests/helpers/task-workspace'

let locked: () => Promise<void> = async () => {}
mock.module(new URL('./runtime.ts', import.meta.url).href, { namedExports: {
  factoryLifecycleEnabled: () => true,
  factoryRuntimeForBot: () => ({ store: { lockTask: async () => { await locked() } } }),
} })
const { withFactoryBackgroundWorkspace: realWorkspaceBoundary } = await import('./background-workspace')
const unitPools = new WeakSet<object>(), unitIssues = new Set<string>()
// The three synthetic transaction-shape cases have an explicit, exact-target
// unit seam. The PostgreSQL case below is not enrolled and uses real membership.
const workspaceBoundary: typeof realWorkspaceBoundary = async (pool, userId, target, work, existing) => {
  if (!unitPools.has(pool)) return realWorkspaceBoundary(pool, userId, target, work, existing)
  assert.equal(userId, 'owner')
  assert.deepEqual(target, { kind: 'issue', id: target.id, botId: null })
  assert.ok(unitIssues.has(target.id), 'only a task constructed by this unit fixture is admissible')
  assert.equal(existing, undefined, 'the host still owns admission before its APP transaction')
  return work()
}
mock.module(new URL('./background-workspace.ts', import.meta.url).href, { namedExports: {
  withFactoryBackgroundWorkspace: workspaceBoundary,
} })
const { queueFactoryTask } = await import('./task-dispatch')
const input = () => {
  const request = { issueId: randomUUID(), botId: null, agentId: randomUUID(), deviceRepoId: randomUUID(), key: randomUUID(), queue: async () => { assert.fail('a durable replay cannot enqueue') } }
  unitIssues.add(request.issueId)
  return request
}
const select = (rows: Record<string, unknown>[]) => ({ command: 'SELECT', rows, rowCount: rows.length, fields: [] })
const receipt = () => select([{ same: true, status: 'pending', taskId: randomUUID(), result: { runId: 'already-queued' } }])
const isLock = (sql: string) => sql.startsWith('SELECT pg_advisory_xact_lock')
function fixture(response?: unknown, failure?: Error) {
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
  const pool = { connect: async () => client } as unknown as Pool
  unitPools.add(pool)
  return { pool, calls, released: () => released }
}

test('host dispatch acquires both existing locks in one ordered round trip, with BEGIN separate', async () => {
  const f = fixture()
  locked = async () => {}
  assert.deepEqual(await queueFactoryTask(f.pool, 'owner', input()), { runId: 'already-queued' })
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
    await assert.rejects(queueFactoryTask(f.pool, 'owner', input()), /Invalid Factory dispatch locks/)
    assert.equal(f.calls.filter(call => call.sql.startsWith('SELECT e.result')).length, 0)
    assert.equal(f.calls.at(-1)?.sql, 'ROLLBACK')
    assert.equal(f.released(), 1)
  }
})

test('a failed lock query preserves its cause and never reads a replay receipt', async () => {
  const failure = new Error('fixture lock failure')
  const f = fixture(undefined, failure)
  await assert.rejects(queueFactoryTask(f.pool, 'owner', input()), error => error === failure)
  assert.equal(f.calls.filter(call => call.sql.startsWith('SELECT e.result')).length, 0)
  assert.equal(f.calls.at(-1)?.sql, 'ROLLBACK')
  assert.equal(f.released(), 1)
})

const dbURL = disposableDatabase() ? process.env.E2E_DATABASE_URL : undefined
if (process.env.REQUIRE_DB === '1') assert.ok(dbURL, 'actual isolated PostgreSQL is required')

test('PG: quoted lock keys retain ordering, block their peers until commit, and release afterward', { skip: !dbURL, timeout: 10000 }, async () => {
  const parsed = new URL(dbURL!)
  assert.equal(parsed.hostname, '127.0.0.1')
  const pool = new Pool({ connectionString: dbURL, max: 4 })
  const closeWorkspace = await bindFixtureWorkspaceDatabase(pool)
  const runner = await pool.connect(), blocker = await pool.connect(), observer = await pool.connect()
  const owner = "owner'\\; SELECT 'not SQL' --"
  const request = input()
  const keys = [JSON.stringify(['factory-host-dispatch', owner, request.issueId]), JSON.stringify([owner, request.issueId])]
  const calls: string[] = []
  let pending: Promise<{ runId: string }> | undefined
  let workspaceId: string | undefined
  try {
    await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$1,$2,true,now(),now())',
      [owner, `factory-lock-${randomUUID()}@example.invalid`])
    workspaceId = await seedFixtureWorkspace(pool, owner, 'team')
    await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority,scope,"workspaceId","ownershipState")
      VALUES ($1,$2,'Ordered dispatch locks','{"type":"doc","content":[]}','todo','normal','workspace',$3,'bound')`, [request.issueId, owner, workspaceId])
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
    pending = queueFactoryTask({ query: pool.query.bind(pool), connect: async () => wrapped } as unknown as Pool, owner, request)
    pending.catch(() => {})
    const deadline = Date.now() + 2000
    let waiting = false
    while (Date.now() < deadline) {
      const { rows: [state] } = await observer.query('SELECT count(*) FILTER (WHERE granted)::int AS held,count(*) FILTER (WHERE NOT granted)::int AS waiting FROM pg_locks WHERE pid=$1 AND locktype=$2', [pid, 'advisory'])
      if (state.held === 1 && state.waiting === 1) { waiting = true; break }
      await delay(5)
    }
    assert.equal(waiting, true, 'the first lock is held while waiting for the second')
    await blocker.query('COMMIT')
    assert.deepEqual(await pending, { runId: 'already-queued' })
    assert.equal(calls.filter(isLock).length, 1)
    for (const key of keys) assert.equal((await observer.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired', [key])).rows[0].acquired, true)
  } finally {
    await blocker.query('ROLLBACK').catch(() => {})
    await pending?.catch(() => {})
    await runner.query('ROLLBACK').catch(() => {})
    runner.release(); blocker.release(); observer.release()
    try {
      await pool.query('DELETE FROM issues WHERE id=$1', [request.issueId])
      if (workspaceId) {
        await pool.query('DELETE FROM mikka_workspace_members WHERE "workspaceId"=$1', [workspaceId])
        await pool.query('DELETE FROM mikka_workspaces WHERE id=$1', [workspaceId])
      }
      await pool.query('DELETE FROM "user" WHERE id=$1', [owner])
    } finally { await closeWorkspace(); await pool.end() }
    locked = async () => {}
  }
})
