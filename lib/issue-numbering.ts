import 'server-only'
import { and, asc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { issues, users } from '@/lib/db/schema'
import { readIssueMetadata, withIssueMetadata } from '@/lib/issue-metadata'

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export async function allocateIssueNumbers(tx: Transaction, ownerId: string) {
  // Lock the owner row so concurrent creates and legacy backfills never allocate the same number.
  await tx.select({ id: users.id }).from(users).where(eq(users.id, ownerId)).for('update')
  const rows = await tx.select({ id: issues.id, content: issues.content }).from(issues).where(eq(issues.userId, ownerId)).orderBy(asc(issues.createdAt), asc(issues.id)).for('update')
  let next = rows.reduce((max, row) => Math.max(max, readIssueMetadata(row.content).number ?? 0), 0)
  for (const row of rows) {
    const metadata = readIssueMetadata(row.content)
    if (metadata.number) continue
    await tx.update(issues).set({ content: withIssueMetadata(row.content, { ...metadata, number: ++next }) }).where(and(eq(issues.id, row.id), eq(issues.userId, ownerId)))
  }
  return next + 1
}

export async function ensureIssueNumbers(ownerId: string) {
  return db.transaction(tx => allocateIssueNumbers(tx, ownerId))
}
