import 'server-only'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { pendingActions, repositorySettings } from '@/lib/db/schema'

/** Internal persistence for an already-authenticated person's explicit decision. */
export async function writeRepositoryPushApproval(userId: string, key: string, approved: boolean) {
  const push = { approved, remote: 'origin', approvedByUserId: userId, approvedAt: new Date().toISOString() }
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['repository-approval', userId, key])}, 0))`)
    await tx.insert(repositorySettings).values({ userId, remoteKey: key, push }).onConflictDoUpdate({
      target: [repositorySettings.userId, repositorySettings.remoteKey], set: { push, updatedAt: new Date() },
    })
    if (!approved) await tx.update(pendingActions).set({ status: 'declined', decidedAt: new Date() }).where(and(
      eq(pendingActions.userId, userId), eq(pendingActions.action, 'approve_repository_push'), eq(pendingActions.status, 'pending'),
      sql`${pendingActions.input}->>'remoteKey' = ${key}`,
    ))
  })
}
