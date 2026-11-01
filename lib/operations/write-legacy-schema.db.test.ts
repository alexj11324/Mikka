import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import pg from 'pg'
import { validateTarget } from '../../scripts/run-db-tests.mjs'

/** Required CI-only old-schema regression. It can never target retained local
 * PG or production; records remain until the disposable Actions service exits. */
test('gate-off endpoint and legacy approval reads work without new operation schema', { timeout: 20000 }, async () => {
  validateTarget(process.env)
  assert.equal(process.env.REQUIRE_DB, '1')
  const migration = await readFile(new URL('../../drizzle/20261025043000_pending_actions.sql', import.meta.url), 'utf8')
  assert.equal(createHash('sha256').update(migration).digest('hex'), '95da87cf61ec9147d10eac1734ae7dda1650e3ee8dba2bd09d0f8019b546c31d')
  const schema = 'write308_legacy_' + randomUUID().replaceAll('-', '')
  assert.match(schema, /^write308_legacy_[a-f0-9]{32}$/)
  const expectedOptions = '-c search_path=' + schema + ',pg_catalog'
  const allowedAdmin = new WeakSet<object>()
  const budget = { sql: 0, ddl: 0, insert: 0, provider: 0 }
  const originalQuery = pg.Client.prototype.query, originalFetch = globalThis.fetch
  pg.Client.prototype.query = new Proxy(originalQuery, { apply(target, client, args) {
    const p = (client as { connectionParameters: { host: string; port: number; database: string; options?: string } }).connectionParameters
    assert.equal(p.host, '127.0.0.1'); assert.equal(p.port, 5432); assert.equal(p.database, 'mikka_e2e')
    assert.ok(allowedAdmin.has(client) || p.options === expectedOptions, 'only this fixture scope may query')
    const text = typeof args[0] === 'string' ? args[0] : args[0]?.text
    assert.equal(typeof text, 'string')
    assert.ok(!/\b(?:DELETE|DROP|TRUNCATE|UPDATE|CREATE\s+ROLE|ALTER\s+ROLE)\b/i.test(text), 'no deletion, updates or role changes')
    assert.ok(++budget.sql <= 40, 'fixture SQL budget')
    budget.ddl += [...text.matchAll(/\bCREATE\s+(?:SCHEMA|TABLE|INDEX)\b/gi)].length
    budget.insert += [...text.matchAll(/\bINSERT\s+INTO\b/gi)].length
    assert.ok(budget.ddl <= 3 && budget.insert <= 1, 'fixture write budget')
    return Reflect.apply(target, client, args)
  } })
  globalThis.fetch = async () => { budget.provider++; throw Error('real provider request forbidden') }
  const admin = new pg.Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 1, connectionTimeoutMillis: 2000 })
  let failure: unknown
  const previousAvailability = process.env.MIKKA_PERSONAL_WRITES_ENABLED
  process.env.MIKKA_PERSONAL_WRITES_ENABLED = '0'
  let scope: ReturnType<typeof import('../db/request-scope').createRequestDatabaseScope> | undefined
  try {
    const client = await admin.connect(); allowedAdmin.add(client)
    try {
      const version = await client.query('SHOW server_version_num')
      assert.ok(Number(version.rows[0].server_version_num) >= 170000 && Number(version.rows[0].server_version_num) < 180000)
      const absent = await client.query('SELECT to_regnamespace($1) AS name', [schema]); assert.equal(absent.rows[0].name, null)
      await client.query('CREATE SCHEMA "' + schema + '"')
      await client.query('BEGIN')
      await client.query('SET LOCAL search_path="' + schema + '",pg_catalog')
      await client.query(migration)
      const owner = 'synthetic-' + randomUUID(), id = randomUUID()
      await client.query('INSERT INTO pending_actions (id,"userId",action,input) VALUES ($1,$2,$3,$4)', [id, owner, 'send_email', { to: 'fixture@example.invalid', subject: 'Fixture', body: 'Fixture' }])
      await client.query('COMMIT')
      const url = new URL(process.env.E2E_DATABASE_URL!); url.searchParams.set('options', expectedOptions)
      const { createRequestDatabaseScope } = await import('../db/request-scope')
      scope = createRequestDatabaseScope(url.href)
      const { listPendingActions } = await import('../pending-action-store')
      const own = await scope.run(() => listPendingActions(owner))
      assert.equal(own.length, 1); assert.equal(own[0].id, id); assert.equal(own[0].action, 'send_email')
      assert.deepEqual(await scope.run(() => listPendingActions('synthetic-other-owner')), [])
      const { POST } = await import('../../app/api/approved-writes/route')
      const before = budget.sql
      const response = await POST(new Request('https://candidate.invalid/api/approved-writes', { method: 'POST', body: '{}' }))
      assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'approvedWritesDisabled' }); assert.equal(budget.sql, before)
      const columns = await client.query('SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2', [schema, 'pending_actions'])
      assert.ok(!columns.rows.some(r => ['intentKey', 'operationBinding'].includes(r.column_name)))
      const tables = await client.query('SELECT table_name FROM information_schema.tables WHERE table_schema=$1', [schema])
      assert.deepEqual(tables.rows.map(r => r.table_name), ['pending_actions'])
      assert.equal(budget.ddl, 3); assert.equal(budget.insert, 1); assert.equal(budget.provider, 0)
      console.log(JSON.stringify({ fixture: schema, budget, oldSchemaReadPassed: true, defaultOffSQL: 0, retainedUntilCIServiceExit: true }))
    } finally { client.release() }
  } catch(error) { failure=error }
  finally {
    const closed=await Promise.allSettled([Promise.resolve().then(()=>scope?.close()),Promise.resolve().then(()=>admin.end())])
    const errors=closed.filter(r=>r.status==='rejected').map(r=>(r as PromiseRejectedResult).reason)
    pg.Client.prototype.query = originalQuery; globalThis.fetch = originalFetch
    if (previousAvailability === undefined) delete process.env.MIKKA_PERSONAL_WRITES_ENABLED
    else process.env.MIKKA_PERSONAL_WRITES_ENABLED = previousAvailability
    if(errors.length)failure=new AggregateError([...(failure?[failure]:[]),...errors],'fixture close failed')
  }
  if(failure)throw failure
})
