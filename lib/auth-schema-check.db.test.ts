import assert from 'node:assert/strict'
import test from 'node:test'
import { isE2eTarget } from '../tests/helpers/e2e-target.mjs'

// Database regressions execute only in CI against ephemeral Postgres 17.
// Local pure runs skip them; REQUIRE_DB=1 makes a missing database fail.
let databaseUrl: string | undefined
try {
  const target = new URL(process.env.E2E_DATABASE_URL ?? '')
  if (isE2eTarget(target.href) && process.env.MIKKA_DATABASE_URL === target.href
    && process.env.DATABASE_URL === target.href) databaseUrl = target.href
} catch { /* no eligible disposable CI database */ }
if (!databaseUrl && process.env.REQUIRE_DB === '1') throw new Error('REQUIRE_DB=1 requires the matching Actions loopback mikka_e2e database')
const dbTest = databaseUrl ? test : test.skip

dbTest('starting auth reads no catalog: migrations own the schema, not a check on every cold start', async () => {
  const { Pool } = await import('pg')
  const probe = new Pool({ connectionString: databaseUrl, max: 1 })
  const catalogReads = async () => Number((await probe.query(`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND query LIKE '%attnotnull%' AND pid <> pg_backend_pid()`)).rows[0].n)
  try {
    const { pool } = await import('./db')
    const seen: string[] = []
    const query = pool.query.bind(pool) as (...args: unknown[]) => unknown
    ;(pool as unknown as { query: unknown }).query = (...args: unknown[]) => {
      const first = args[0]
      seen.push(typeof first === 'string' ? first : String((first as { text?: unknown })?.text ?? ''))
      return query(...args)
    }
    const { auth } = await import('./auth')
    const context = await auth.$context
    assert.equal(context.checkSchema, undefined, 'no runtime schema check is registered')
    await new Promise(resolve => setTimeout(resolve, 200))
    assert.ok(!seen.some(text => /attnotnull|pg_attribute/.test(text)), 'auth did not introspect the catalog')
    assert.equal(await catalogReads(), 0)
  } finally { await probe.end() }
})
