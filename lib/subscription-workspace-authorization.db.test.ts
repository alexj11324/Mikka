import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mock, test } from 'node:test'
import type { Socket } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { Pool, type PoolClient, type QueryResult } from 'pg'
import { and, eq, DrizzleQueryError } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { z } from 'zod'
import { disposableDatabase } from '../tests/helpers/e2e-target.mjs'
import * as schema from './db/workspace-schema'
import { WorkspaceError } from './workspace-error'

const databaseURL = process.env.E2E_DATABASE_URL
const disposable = disposableDatabase(process.env, databaseURL)
if (process.env.REQUIRE_DB === '1' && !disposable) throw new Error('Workspace authorization tests require an isolated local database')
type Measurement = { requests: number; requestBytes: number; responseBytes: number; commands: string[]; rows: number }
const emptyMeasurement = (): Measurement => ({ requests: 0, requestBytes: 0, responseBytes: 0, commands: [], rows: 0 })
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes }); return { promise, resolve } }
const pid = (client: PoolClient) => (client as unknown as { processID: number }).processID

test('one bound workspace SELECT preserves authorization and uses less actual PostgreSQL traffic', { skip: !disposable, timeout: 30_000 }, async t => {
  const admin = new Pool({ connectionString: databaseURL, statement_timeout: 3_000 })
  const name = `workspace_single_${randomUUID().replaceAll('-', '')}`
  await admin.query(`CREATE SCHEMA ${name}`)
  const pool = new Pool({ connectionString: databaseURL, options: `-c search_path=${name}`, max: 3 })
  const db = drizzle(pool, { schema })
  const statements: string[] = []
  let capture: Measurement | undefined
  let before: ((client: PoolClient, text: string) => void) | undefined
  let after: ((client: PoolClient, text: string) => Promise<void>) | undefined
  // The connection-loss test deliberately terminates only its own blocked backend.
  pool.on('error', () => {})
  pool.on('connect', (client: PoolClient) => {
    client.on('error', () => {})
    const socket = (client as unknown as { connection: { stream: Socket } }).connection.stream
    const write = socket.write
    socket.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      if (capture) capture.requestBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
      return Reflect.apply(write, socket, [chunk, ...args])
    }) as Socket['write']
    socket.on('data', (chunk: Buffer) => { if (capture) capture.responseBytes += chunk.byteLength })
    const original = client.query.bind(client)
    client.query = ((...args: unknown[]) => {
      const first = args[0] as string | { text: string }
      const text = typeof first === 'string' ? first : first.text
      statements.push(text); before?.(client, text)
      if (capture) capture.requests++
      const completed = async (result: QueryResult | QueryResult[]) => {
        if (capture) for (const one of Array.isArray(result) ? result : [result]) {
          capture.commands.push(one.command); capture.rows += one.rows.length
        }
        await after?.(client, text)
        return result
      }
      const callback = args.at(-1)
      if (typeof callback === 'function') return Reflect.apply(original, client, [
        ...args.slice(0, -1),
        (error: unknown, result: QueryResult) => {
          if (error) return callback(error, result)
          void completed(result).then(value => callback(null, value), error => callback(error))
        },
      ])
      return (Reflect.apply(original, client, args) as Promise<QueryResult>).then(completed)
    }) as PoolClient['query']
  })
  const mocked = mock.module(new URL('./workspace-db.ts', import.meta.url).href, {
    namedExports: { workspaceDb: db, workspacePool: pool },
  })
  const workspace = randomUUID()
  const select = (connection: Pick<typeof db, 'select'>, owner: string, id: string) =>
    connection.select({ id: schema.workspaces.id }).from(schema.workspaces)
      .innerJoin(schema.workspaceMembers, eq(schema.workspaceMembers.workspaceId, schema.workspaces.id))
      .where(and(eq(schema.workspaces.id, id), eq(schema.workspaceMembers.userId, owner), eq(schema.workspaceMembers.status, 'active')))
      .for('share').limit(1)
  // Preserve the former public function as a real pg/Drizzle baseline.
  const baseline = async (owner: string, id: string) => {
    z.uuid().parse(id)
    await db.transaction(async tx => {
      const [row] = await select(tx, owner, id)
      if (!row) throw new WorkspaceError('workspaceAccessDenied')
    })
  }
  const measure = async (operation: () => Promise<unknown>) => {
    const value = emptyMeasurement()
    statements.length = 0; capture = value
    try { await operation() } finally { capture = undefined }
    return value
  }
  const member = (owner: string, status = 'active') => admin.query(
    `INSERT INTO ${name}.mikka_workspace_members VALUES ($1,$2,$3) ON CONFLICT ("workspaceId","userId") DO UPDATE SET status=EXCLUDED.status`,
    [workspace, owner, status],
  )
  const waitForBlock = async (blocked: number, blocker: number) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const { rows: [row] } = await admin.query('SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked', [blocked, blocker])
      if (row.blocked) return
      await delay(10)
    }
    assert.fail('the authorizer did not wait for the expected PostgreSQL row lock')
  }
  const wire: Array<{ case: string; baseline: Measurement; candidate: Measurement }> = []
  try {
    await admin.query(`CREATE TABLE ${name}.mikka_workspaces(id uuid PRIMARY KEY);
      CREATE TABLE ${name}.mikka_workspace_members("workspaceId" uuid,"userId" text,status text,PRIMARY KEY("workspaceId","userId"))`)
    await admin.query(`INSERT INTO ${name}.mikka_workspaces VALUES ($1)`, [workspace])
    const warmed = await pool.connect(); warmed.release()
    const { authorizeSubscriptionWorkspace: candidate } = await import('./subscription-runtime')
    for (const [label, owner] of [
      ['normal', 'owner'], ['empty owner', ''], ['unicode', '自有账户'],
      ['quotes and backslash', "fixture'\\owner"],
      ['SQL-looking text', "fixture'; DELETE FROM mikka_workspaces; --"],
      ['long identity', 'owner'.repeat(4_000)], ['quotes expansion', "'".repeat(256)],
      ['placeholder-looking text', 'literal $1 owner'],
    ] as const) await t.test(label, async () => {
      await member(owner)
      const old = await measure(() => baseline(owner, workspace))
      const current = await measure(() => candidate(owner, workspace))
      assert.equal(old.requests, 3); assert.equal(current.requests, 1)
      assert.deepEqual(old.commands, ['BEGIN', 'SELECT', 'COMMIT'])
      assert.deepEqual(current.commands, ['SELECT'])
      assert.equal(current.rows, 1); assert.equal(current.rows, old.rows)
      assert.ok(current.requestBytes + current.responseBytes < old.requestBytes + old.responseBytes)
      assert.equal(statements[0], select(db, owner, workspace).toSQL().sql)
      assert.ok(statements[0]!.includes('$1') && statements[0]!.includes('$2'))
      wire.push({ case: label, baseline: old, candidate: current })
    })
    for (const [label, owner, id] of [
      ['foreign owner', 'foreign', workspace], ['foreign workspace', 'owner', randomUUID()],
      ['suspended membership', 'suspended', workspace], ['deleted membership', 'deleted', workspace],
    ]) await t.test(label!, async () => {
      if (owner === 'suspended') await member(owner, 'suspended')
      let downstream = 0
      const old = await measure(() => assert.rejects(baseline(owner!, id!).then(() => { downstream++ }), { name: 'WorkspaceError', message: 'workspaceAccessDenied' }))
      const current = await measure(() => assert.rejects(candidate(owner!, id!).then(() => { downstream++ }), { name: 'WorkspaceError', message: 'workspaceAccessDenied' }))
      assert.equal(downstream, 0)
      assert.deepEqual(old.commands, ['BEGIN', 'SELECT', 'ROLLBACK'])
      assert.deepEqual(current.commands, ['SELECT']); assert.equal(current.rows, 0)
      assert.equal(current.requests, 1)
      assert.ok(current.requestBytes + current.responseBytes < old.requestBytes + old.responseBytes)
      wire.push({ case: label!, baseline: old, candidate: current })
    })
    await t.test('invalid UUID remains an early refusal without any SQL', async () => {
      for (const authorize of [baseline, candidate]) {
        const result = await measure(() => assert.rejects(authorize('owner', 'not-a-uuid'), { name: 'ZodError' }))
        assert.deepEqual(result, emptyMeasurement())
      }
    })
    await t.test('NUL keeps the same parameterized query and database error', async () => {
      for (const authorize of [baseline, candidate]) await assert.rejects(authorize('bad\0owner', workspace), error => {
        assert.ok(error instanceof DrizzleQueryError)
        assert.ok(error.cause instanceof Error && 'code' in error.cause)
        assert.equal(error.cause.code, '22021')
        assert.equal(error.query, select(db, 'bad\0owner', workspace).toSQL().sql)
        return true
      })
    })
    await t.test('fresh calls see suspension, restoration and deletion', async () => {
      await candidate('owner', workspace)
      await member('owner', 'suspended')
      await assert.rejects(candidate('owner', workspace), { message: 'workspaceAccessDenied' })
      await member('owner'); await candidate('owner', workspace)
      await admin.query(`DELETE FROM ${name}.mikka_workspace_members WHERE "userId"='owner'`)
      await assert.rejects(candidate('owner', workspace), { message: 'workspaceAccessDenied' })
      await member('owner')
    })
    for (const [label, authorize] of [['baseline', baseline], ['candidate', candidate]] as const) {
      await t.test(`${label}: a locked membership is rechecked after committed suspension`, async () => {
        const blocker = await pool.connect(), entered = deferred()
        let authPid = 0
        before = (client, text) => { if (text.includes('for share')) { authPid = pid(client); entered.resolve() } }
        await blocker.query('begin')
        await blocker.query('UPDATE mikka_workspace_members SET status=$1 WHERE "userId"=$2', ['suspended', 'owner'])
        let authorization: Promise<unknown> | undefined
        try {
          authorization = assert.rejects(authorize('owner', workspace), { message: 'workspaceAccessDenied' })
          await entered.promise; await waitForBlock(authPid, pid(blocker))
          await blocker.query('commit'); await authorization
        } finally {
          before = undefined; await blocker.query('rollback')
          await authorization?.catch(() => {}); blocker.release(); await member('owner')
        }
      })
      await t.test(`${label}: revocation can commit after lock release before the caller resumes`, async () => {
        const entered = deferred(), resume = deferred()
        after = async (_client, text) => {
          if (label === 'baseline' ? text === 'commit' : text.includes('for share')) {
            entered.resolve(); await resume.promise
          }
        }
        const authorization = authorize('owner', workspace)
        try {
          await entered.promise
          // Real UPDATE must finish while this function's promise is still held.
          await member('owner', 'suspended')
          const { rows: [row] } = await admin.query(`SELECT status FROM ${name}.mikka_workspace_members WHERE "userId"='owner'`)
          assert.equal(row.status, 'suspended')
          resume.resolve(); await authorization
          after = undefined
          await assert.rejects(authorize('owner', workspace), { message: 'workspaceAccessDenied' })
        } finally {
          resume.resolve(); after = undefined; await authorization.catch(() => {})
          await member('owner')
        }
      })
      await t.test(`${label}: losing the blocked database connection cannot grant access`, async () => {
        const blocker = await pool.connect(), entered = deferred()
        let authPid = 0, downstream = 0
        before = (client, text) => { if (text.includes('for share')) { authPid = pid(client); entered.resolve() } }
        await blocker.query('begin')
        await blocker.query('UPDATE mikka_workspace_members SET status=status WHERE "userId"=$1', ['owner'])
        const outcome = authorize('owner', workspace).then(() => { downstream++; return null }, (error: unknown) => error)
        try {
          await entered.promise; await waitForBlock(authPid, pid(blocker))
          assert.notEqual(authPid, pid(blocker))
          assert.equal((await admin.query('SELECT pg_terminate_backend($1::int) AS terminated', [authPid])).rows[0].terminated, true)
          const error = await outcome
          assert.ok(error instanceof Error)
          assert.equal(downstream, 0)
        } finally {
          before = undefined; await blocker.query('rollback')
          await outcome; blocker.release()
        }
        await candidate('owner', workspace)
      })
    }
    await t.test('SELECT errors retain their original query, SQLSTATE and downstream refusal', async () => {
      await admin.query(`ALTER TABLE ${name}.mikka_workspace_members RENAME TO unavailable_members`)
      try {
        for (const authorize of [baseline, candidate]) {
          let downstream = 0
          await assert.rejects(authorize('owner', workspace).then(() => { downstream++ }), error => {
            assert.ok(error instanceof DrizzleQueryError)
            assert.ok(error.cause instanceof Error && 'code' in error.cause)
            assert.equal(error.cause.code, '42P01')
            assert.equal(error.query, select(db, 'owner', workspace).toSQL().sql)
            return true
          })
          assert.equal(downstream, 0)
        }
      } finally { await admin.query(`ALTER TABLE ${name}.unavailable_members RENAME TO mikka_workspace_members`) }
      await candidate('owner', workspace)
    })
    t.diagnostic('workspace_single_authorization_wire=' + JSON.stringify(wire))
  } finally {
    capture = undefined; before = undefined; after = undefined
    mocked.restore(); await pool.end()
    await admin.query(`DROP SCHEMA ${name} CASCADE`)
    assert.equal((await admin.query('SELECT count(*)::int AS count FROM pg_namespace WHERE nspname=$1', [name])).rows[0].count, 0)
    await admin.end()
  }
})
