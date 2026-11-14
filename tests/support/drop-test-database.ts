// Shared cleanup for DB tests that create a throwaway `*_e2e` database and
// drop it WITH (FORCE) afterwards.
import { randomUUID } from 'node:crypto'
import type { Client, Pool, QueryResultRow } from 'pg'

type Admin = Pool | Client

const query = <R extends QueryResultRow = QueryResultRow>(admin: Admin, sql: string, values?: unknown[]) =>
  (admin as Pool).query<R>(sql, values as never[])

const createdByPool = new WeakMap<object, Map<string, string>>()
const databaseNamePattern = /^[a-z0-9_]+_e2e$/
const ownershipCommentPrefix = 'mikka-test-database:'

function assertTestDatabaseName(database: string) {
  if (!databaseNamePattern.test(database)) throw new Error('test database must use a safe *_e2e identifier')
}

function quoteIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`
}

function quoteLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`
}

/** Create a disposable database and persist positive same-run provenance on it. */
export async function createTestDatabase(admin: Admin, database: string, template?: string) {
  assertTestDatabaseName(database)
  if (template !== undefined && template !== 'template0') assertTestDatabaseName(template)
  const ownershipToken = `${ownershipCommentPrefix}${randomUUID()}`
  const statement = `CREATE DATABASE ${quoteIdentifier(database)}${template === undefined ? '' : ` TEMPLATE ${quoteIdentifier(template)}`}`
  const result = await query(admin, statement)
  if (result.command !== 'CREATE DATABASE') throw new Error('database creation did not return a CREATE DATABASE result')
  // Record the CREATE immediately, but cleanup still requires the persisted
  // marker. If tagging fails, it will therefore fail closed instead of dropping
  // a database whose current ownership cannot be proved.
  let created = createdByPool.get(admin)
  if (!created) { created = new Map(); createdByPool.set(admin, created) }
  created.set(database, ownershipToken)
  await query(admin, `COMMENT ON DATABASE ${quoteIdentifier(database)} IS ${quoteLiteral(ownershipToken)}`)
  return ownershipToken
}


const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Ends each pool and waits until every one of its client sockets has closed.
 * pg-pool's end() resolves once clients are asked to close, not once they are
 * gone. A FORCE drop in that gap kills a still-closing backend, and its FATAL
 * 57P01 ("terminating connection due to administrator command") reaches the
 * pool as an 'error' nobody listens for: an uncaught exception that fails
 * whichever test is running.
 */
export async function endPoolsAndWait(...pools: (Pool | null | undefined)[]) {
  await Promise.all(pools.filter((pool): pool is Pool => Boolean(pool)).map(async pool => {
    const open = pool.totalCount
    let removed = 0
    const closed = new Promise<void>(resolve => {
      if (!open) return resolve()
      pool.on('remove', () => { if (++removed >= open) resolve() })
    })
    await pool.end()
    // Bounded: a socket that never reports its end still falls to the backstop below.
    await Promise.race([closed, delay(5000)])
  }))
}

/**
 * Ends the test's own pools, waits for every client backend on the database
 * to exit (this also covers module-level pools the test ended itself), then
 * drops it WITH (FORCE). The name must be a test database (`*_e2e`).
 */
export async function dropTestDatabase(admin: Admin, database: string, ...pools: (Pool | null | undefined)[]) {
  assertTestDatabaseName(database)
  const ownershipToken = createdByPool.get(admin)?.get(database)
  if (!ownershipToken) throw new Error('dropTestDatabase requires same-run creation through createTestDatabase on this admin pool')
  const assertMarker = async () => {
    const { rows } = await query<{ ownership: string | null }>(admin,
      "SELECT shobj_description(oid, 'pg_database') AS ownership FROM pg_database WHERE datname=$1",
      [database],
    )
    if (rows[0]?.ownership !== ownershipToken) throw new Error(`refusing to drop ${database}: same-run ownership marker is absent or mismatched`)
  }
  await assertMarker()
  await endPoolsAndWait(...pools)
  for (let i = 0; i < 100; i++) {
    const { rowCount } = await query(admin, "SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND backend_type='client backend'", [database])
    if (!rowCount) break
    await delay(50)
  }
  // Recheck immediately before the destructive statement in case the name was
  // removed and recreated while pools were closing.
  await assertMarker()
  await query(admin, `DROP DATABASE ${quoteIdentifier(database)} WITH (FORCE)`)
  createdByPool.get(admin)?.delete(database)
}
