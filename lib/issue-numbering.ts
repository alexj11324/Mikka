import 'server-only'
import { and, asc, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { issues, users } from '@/lib/db/schema'
import { readIssueMetadata, withIssueMetadata } from '@/lib/issue-metadata'

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

export async function ensureIssueNumbers(ownerId: string) {
  return db.transaction(async tx => {
    // Only historical/unversioned writers can leave missing metadata after the
    // expand backfill. A page read fills those rows without reserving a number
    // for a task that will never be created.
    await tx.select({ id: users.id }).from(users).where(eq(users.id, ownerId)).for('no key update')
    const rows = await tx.select({ id: issues.id, content: issues.content }).from(issues)
      .where(and(eq(issues.userId, ownerId), sql`number IS NULL`))
      .orderBy(asc(issues.createdAt), asc(issues.id)).for('update')
    for (const row of rows) {
      const metadata = readIssueMetadata(row.content)
      const number = await allocateIssueNumbers(tx, ownerId)
      await tx.update(issues).set({ content: withIssueMetadata(row.content, { ...metadata, number }) }).where(and(eq(issues.id, row.id), eq(issues.userId, ownerId)))
    }
    const result = await tx.execute<{ number: string }>(sql`SELECT "lastIssueNumber" + 1 AS number FROM "user" WHERE id = ${ownerId}`)
    if (!result.rows[0]) throw new Error('Issue number owner unavailable')
    return Number(result.rows[0].number)
  })
}
