import 'server-only'
import { sql } from 'drizzle-orm'
import { db, withDatabaseTransaction } from '@/lib/db'

/** The deletion request waits for already-started managed object writes. */
export async function withAccountWrite<T>(userId: string, work: () => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    await tx.execute(sql`select mikka_account_assert_writable(${userId})`)
    return withDatabaseTransaction(tx, work)
  })
}
