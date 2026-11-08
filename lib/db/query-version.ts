import 'server-only'
import { sql, type SQLWrapper } from 'drizzle-orm'
import { db } from '@/lib/db'

const fingerprint = sql<string>`md5(coalesce(string_agg(md5(to_jsonb(snapshot)::text), ',' order by md5(to_jsonb(snapshot)::text)), ''))`

/** Fingerprint a bounded result inside Postgres; unchanged polls never transfer its rows. */
export async function queryVersion(query: SQLWrapper, executor: Pick<typeof db, 'execute'> = db): Promise<string> {
  const result = await executor.execute<{ version: string }>(sql`
    select ${fingerprint} as version
    from (${query}) as snapshot
  `)
  return result.rows[0].version
}

/** Read a bounded snapshot's fingerprint and expiry under the same statement.
 * The caller supplies an aggregate expiry expression over the `snapshot` alias. */
export async function queryVersionWithExpiry(query: SQLWrapper, expiresAt: SQLWrapper, executor: Pick<typeof db, 'execute'> = db): Promise<{ version: string; expiresAt: Date | string | null }> {
  const result = await executor.execute<{ version: string; expiresAt: Date | string | null }>(sql`
    select ${fingerprint} as version, ${expiresAt} as "expiresAt"
    from (${query}) as snapshot
  `)
  return result.rows[0]
}
