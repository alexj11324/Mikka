// Shared cleanup for DB tests that create a throwaway `*_e2e` database and
// drop it WITH (FORCE) afterwards.
import type { Pool } from 'pg'

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
export async function dropTestDatabase(admin: Pool, database: string, ...pools: (Pool | null | undefined)[]) {
  if (!/^[a-z0-9_]+_e2e$/.test(database)) throw new Error('dropTestDatabase only drops throwaway *_e2e databases')
  await endPoolsAndWait(...pools)
  for (let i = 0; i < 100; i++) {
    const { rowCount } = await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND backend_type='client backend'", [database])
    if (!rowCount) break
    await delay(50)
  }
  await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
}
