import 'server-only'
import { createHash, randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { writeTransaction } from '../operations/write-transaction'

/** Same sliding minute as the service, shared across durable workers/restarts.
 * Reuse Better Auth's existing rateLimit storage in a separate hashed namespace.
 * Rows claim request count only; no provider I/O or money reservation lives here. */
export async function consumeWebRate(pool: Pick<Pool, 'connect'>, userId: string, now: number, limit: number, signal?: AbortSignal) {
  const prefix = `web-rate:${createHash('sha256').update(userId).digest('hex')}:`
  return writeTransaction(pool, async tx => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [prefix])
    // Only this user's expired web rows are recycled; auth counters are untouched.
    await tx.query('DELETE FROM "rateLimit" WHERE key LIKE $1 AND "lastRequest" <= $2', [`${prefix}%`, now-60_000])
    const { rows: [row] } = await tx.query('SELECT COALESCE(sum(count),0) AS n FROM "rateLimit" WHERE key LIKE $1', [`${prefix}%`])
    if (Number(row.n) >= limit) return false
    const id = randomUUID()
    await tx.query('INSERT INTO "rateLimit" (id,key,count,"lastRequest") VALUES ($1,$2,1,$3)', [id,`${prefix}${id}`,now])
    return true
  }, { signal })
}
