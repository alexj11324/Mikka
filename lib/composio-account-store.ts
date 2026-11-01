import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { composioAccounts } from '@/lib/db/schema'
import type { ComposioAccountRecord } from '@/lib/composio-accounts'

// Mikka's own notes on Composio connected accounts: the email read at connect
// time and the chosen default per toolkit. Callers check ownership in Composio
// first; every write is also scoped to the user.

export async function listComposioAccountRecords(userId: string): Promise<ComposioAccountRecord[]> {
  return db.select({
    accountId: composioAccounts.accountId,
    toolkit: composioAccounts.toolkit,
    email: composioAccounts.email,
    emailChecked: sql<boolean>`${composioAccounts.emailCheckedAt} is not null`,
    lastAttemptAt: composioAccounts.lastAttemptAt,
    isDefault: composioAccounts.isDefault,
    needsReconnect: sql<boolean>`${composioAccounts.needsReconnectAt} is not null`,
  })
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

/** What the provider said: the email, or null when it gave none (kept too, so it is not asked again). */
export async function saveComposioAccountEmail(userId: string, toolkit: string, accountId: string, email: string | null) {
  const now = new Date()
  await db.insert(composioAccounts).values({ accountId, userId, toolkit, email, emailCheckedAt: now, lastAttemptAt: now })
    .onConflictDoUpdate({ target: composioAccounts.accountId, set: { email, emailCheckedAt: now, lastAttemptAt: now, updatedAt: now }, setWhere: sql`${composioAccounts.userId} = ${userId}` })
}

/** A try that got no final answer (rate limit, server error, timeout): only the time, for the cooldown. */
export async function noteComposioEmailAttempt(userId: string, toolkit: string, accountId: string) {
  const now = new Date()
  await db.insert(composioAccounts).values({ accountId, userId, toolkit, lastAttemptAt: now })
    .onConflictDoUpdate({ target: composioAccounts.accountId, set: { lastAttemptAt: now, updatedAt: now }, setWhere: sql`${composioAccounts.userId} = ${userId}` })
}

/** The provider refused the person's authorization through this account: it shows as needing reconnection. */
export async function markComposioNeedsReconnect(userId: string, toolkit: string, accountId: string, now = new Date()) {
  await db.insert(composioAccounts).values({ accountId, userId, toolkit, needsReconnectAt: now })
    .onConflictDoUpdate({ target: composioAccounts.accountId, set: { needsReconnectAt: now, updatedAt: now }, setWhere: sql`${composioAccounts.userId} = ${userId}` })
}

/** A read through this account worked again: it no longer needs reconnection. */
export async function clearComposioNeedsReconnect(userId: string, accountId: string) {
  await db.update(composioAccounts).set({ needsReconnectAt: null, updatedAt: new Date() })
    .where(and(eq(composioAccounts.userId, userId), eq(composioAccounts.accountId, accountId), sql`${composioAccounts.needsReconnectAt} is not null`))
}

export async function forgetComposioAccount(userId: string, accountId: string) {
  await db.delete(composioAccounts).where(and(eq(composioAccounts.userId, userId), eq(composioAccounts.accountId, accountId)))
}
