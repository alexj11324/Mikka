import 'server-only'
import { sql, type SQLWrapper } from 'drizzle-orm'
import { db } from '@/lib/db'

/** Fingerprint a bounded result inside Postgres; unchanged polls never transfer its rows. */
export async function queryVersion(query: SQLWrapper, executor: Pick<typeof db, 'execute'> = db): Promise<string> {
  const result = await executor.execute<{ version: string }>(sql`
    select md5(coalesce(string_agg(md5(to_jsonb(snapshot)::text), ',' order by md5(to_jsonb(snapshot)::text)), '')) as version
    from (${query}) as snapshot
  `)
  return result.rows[0].version
}
