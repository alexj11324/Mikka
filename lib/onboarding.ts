import 'server-only'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { userOnboarding } from '@/lib/db/schema'

/** Whether the person has finished or skipped the first-run guide (docs/design/onboarding.md). */
export async function onboardingDone(userId: string) {
  const [row] = await db.select({ userId: userOnboarding.userId }).from(userOnboarding).where(eq(userOnboarding.userId, userId)).limit(1)
  return Boolean(row)
}

/** Marks the guide done; the first time wins. */
export async function finishOnboarding(userId: string) {
  await db.insert(userOnboarding).values({ userId }).onConflictDoNothing()
}

/** Replays only this person's guide. */
export async function resetOnboardingForUser(userId: string) {
  await db.delete(userOnboarding).where(eq(userOnboarding.userId, userId))
}
