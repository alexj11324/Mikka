import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { composioAccounts } from '@/lib/db/schema'
import type { ComposioAccountRecord } from '@/lib/composio-accounts'

// Mikka's own notes on Composio connected accounts: the email read at connect
// time and the chosen default per toolkit. Callers check ownership in Composio
// first; every write is also scoped to the user.

export async function listComposioAccountRecords(userId: string): Promise<ComposioAccountRecord[]> {
  return db.select({ accountId: composioAccounts.accountId, email: composioAccounts.email, isDefault: composioAccounts.isDefault })
    .from(composioAccounts).where(eq(composioAccounts.userId, userId))
}

export async function chosenComposioDefault(userId: string, toolkit: string): Promise<string | null> {
  const [row] = await db.select({ accountId: composioAccounts.accountId }).from(composioAccounts)
    .where(and(eq(composioAccounts.userId, userId), eq(composioAccounts.toolkit, toolkit), eq(composioAccounts.isDefault, true))).limit(1)
  return row?.accountId ?? null
}

/** Makes this the toolkit's default for the person, clearing any other. */
export async function chooseComposioDefault(userId: string, toolkit: string, accountId: string) {
  await db.transaction(async tx => {
    await tx.update(composioAccounts).set({ isDefault: false, updatedAt: new Date() })
      .where(and(eq(composioAccounts.userId, userId), eq(composioAccounts.toolkit, toolkit), eq(composioAccounts.isDefault, true)))
    await tx.insert(composioAccounts).values({ accountId, userId, toolkit, isDefault: true })
      .onConflictDoUpdate({ target: composioAccounts.accountId, set: { isDefault: true, updatedAt: new Date() }, setWhere: sql`${composioAccounts.userId} = ${userId}` })
  })
}

export async function saveComposioAccountEmail(userId: string, toolkit: string, accountId: string, email: string) {
  await db.insert(composioAccounts).values({ accountId, userId, toolkit, email })
    .onConflictDoUpdate({ target: composioAccounts.accountId, set: { email, updatedAt: new Date() }, setWhere: sql`${composioAccounts.userId} = ${userId}` })
}

export async function forgetComposioAccount(userId: string, accountId: string) {
  await db.delete(composioAccounts).where(and(eq(composioAccounts.userId, userId), eq(composioAccounts.accountId, accountId)))
}
