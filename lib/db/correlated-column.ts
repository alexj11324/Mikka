import { sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'

/** Keep the outer table explicit inside correlated subqueries. Drizzle strips
 * Column qualifiers in single-table SELECT fields, where an inner id/userId
 * would otherwise capture the reference. Table + identifier retains it. */
export function correlatedColumn(column: AnyPgColumn) {
  return sql`${column.table}.${sql.identifier(column.name)}`
}
