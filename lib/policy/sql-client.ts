import { sql, type SQL } from "drizzle-orm";
import type { PoolClient, QueryResult } from "pg";

export type PolicyClient = Pick<PoolClient, "query">;
/** Policy queries are fixed parameterized text. Reuse an existing transaction
 * connection instead of borrowing from a bounded pool while holding locks. */
export function policySqlClient(
  execute: (query: SQL) => Promise<QueryResult>,
): PolicyClient {
  const query = async (text: string, values: unknown[] = []) => {
    if (typeof text !== "string") throw new Error("Policy query requires text");
    const chunks = text.split(/(\$[1-9][0-9]*)/g).map((part, index) => {
      if (index % 2 === 0) return sql.raw(part);
      const position = Number(part.slice(1)) - 1;
      if (position >= values.length)
        throw new Error("Policy parameter missing");
      return sql`${values[position]}`;
    });
    return execute(sql.join(chunks, sql.raw("")));
  };
  // Internal policy callers use only the promise-returning text/values overload.
  return { query: query as PolicyClient["query"] };
}
