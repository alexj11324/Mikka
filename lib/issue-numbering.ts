import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export async function allocateIssueNumbers(tx: Transaction, ownerId: string) {
  // Transactional UPDATE serializes each owner's allocations and rolls back
  // with a failed creation. It never scans or locks the owner's issue rows.
  // PostgreSQL takes NO KEY UPDATE here, compatible with FK KEY SHARE.
  const result = await tx.execute<{ number: string }>(sql`
    UPDATE "user" SET "lastIssueNumber" = "lastIssueNumber" + 1
    WHERE id = ${ownerId} AND "lastIssueNumber" < ${Number.MAX_SAFE_INTEGER}
    RETURNING "lastIssueNumber" AS number
  `)
  if (!result.rows[0]) throw new Error('Issue number owner unavailable or counter exhausted')
  return Number(result.rows[0].number)
}
