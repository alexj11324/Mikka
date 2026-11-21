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

/** Independent projections in one database share a statement snapshot and
 * transfer only their fingerprints. Never combine queries from different DBs. */
export async function queryVersions<Key extends string>(queries: Record<Key, SQLWrapper>, executor: Pick<typeof db, 'execute'> = db): Promise<Record<Key, string>> {
  const fields = Object.entries(queries).map(([key, query]) => sql`(select ${fingerprint} from (${query as SQLWrapper}) as snapshot) as ${sql.identifier(key)}`)
  const result = await executor.execute<Record<Key, string>>(sql`select ${sql.join(fields, sql`, `)}`)
  return result.rows[0]
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
