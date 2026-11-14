import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'pg'
import { createTestDatabase, dropTestDatabase } from './drop-test-database'

function fakePool() {
  const comments = new Map<string, string>()
  const calls: string[] = []
  const pool = {
    async query(sql: string, values?: unknown[]) {
      calls.push(sql)
      if (sql.startsWith('CREATE DATABASE ')) {
        const name = sql.match(/^CREATE DATABASE "([^"]+)"/)?.[1]
        assert.ok(name)
        return { command: 'CREATE DATABASE', rows: [], rowCount: null }
      }
      if (sql.startsWith('COMMENT ON DATABASE ')) {
        const name = sql.match(/^COMMENT ON DATABASE "([^"]+)" IS '([^']+)'$/)?.[1]
        const marker = sql.match(/^COMMENT ON DATABASE "([^"]+)" IS '([^']+)'$/)?.[2]
        assert.ok(name && marker)
        comments.set(name, marker)
        return { command: 'COMMENT', rows: [], rowCount: null }
      }
      if (sql.includes('shobj_description')) {
        const name = String(values?.[0])
        return { command: 'SELECT', rows: [{ ownership: comments.get(name) ?? null }], rowCount: comments.has(name) ? 1 : 0 }
      }
      if (sql.includes('pg_stat_activity')) return { command: 'SELECT', rows: [], rowCount: 0 }
      if (sql.startsWith('DROP DATABASE ')) {
        const name = sql.match(/^DROP DATABASE "([^"]+)" WITH \(FORCE\)$/)?.[1]
        assert.ok(name)
        comments.delete(name)
        return { command: 'DROP DATABASE', rows: [], rowCount: null }
      }
      throw new Error(`unexpected fake SQL: ${sql}`)
    },
  }
  return { pool: pool as unknown as Pool, comments, calls }
}

test('cleanup fails closed when the same-run creation record is absent', async () => {
  const { pool, calls } = fakePool()
  await assert.rejects(dropTestDatabase(pool, 'missing_e2e'), /same-run creation/)
  assert.deepEqual(calls, [])
})

test('cleanup fails closed when invoked with a different admin pool', async () => {
  const created = fakePool()
  const other = fakePool()
  await createTestDatabase(created.pool, 'owned_e2e')
  await assert.rejects(dropTestDatabase(other.pool, 'owned_e2e'), /same-run creation/)
  assert.equal(other.calls.length, 0)
})

test('cleanup refuses a database whose persisted ownership marker changed', async () => {
  const { pool, comments, calls } = fakePool()
  await createTestDatabase(pool, 'owned_e2e')
  comments.set('owned_e2e', 'another-run')
  await assert.rejects(dropTestDatabase(pool, 'owned_e2e'), /marker is absent or mismatched/)
  assert.equal(calls.some(sql => sql.startsWith('DROP DATABASE ')), false)
})

test('same-run creation and matching ownership marker permit cleanup', async () => {
  const { pool, calls, comments } = fakePool()
  const token = await createTestDatabase(pool, 'owned_e2e', 'template0')
  assert.match(token, /^mikka-test-database:/)
  assert.equal(comments.get('owned_e2e'), token)
  await dropTestDatabase(pool, 'owned_e2e')
  assert.equal(comments.has('owned_e2e'), false)
  assert.equal(calls.filter(sql => sql.startsWith('DROP DATABASE ')).length, 1)
  await assert.rejects(dropTestDatabase(pool, 'owned_e2e'), /same-run creation/)
})
