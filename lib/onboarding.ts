import 'server-only'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { setupChecklistDismissals, userOnboarding, userOnboardingProgress } from '@/lib/db/schema'
import { normalizeProgress, type OnboardingProgress } from '@/lib/onboarding-steps'

/** Whether the person has finished or skipped the first-run guide (docs/design/onboarding.md). */
export async function onboardingDone(userId: string) {
  const [row] = await db.select({ userId: userOnboarding.userId }).from(userOnboarding).where(eq(userOnboarding.userId, userId)).limit(1)
  return Boolean(row)
}

/** Marks the guide done; the first time wins. Its unfinished place is no longer needed. */
export async function finishOnboarding(userId: string) {
  await db.insert(userOnboarding).values({ userId }).onConflictDoNothing()
  await db.delete(userOnboardingProgress).where(eq(userOnboardingProgress.userId, userId))
}

/** Replays only this person's guide, from the start. */
export async function resetOnboardingForUser(userId: string) {
  await db.delete(userOnboarding).where(eq(userOnboarding.userId, userId))
  await db.delete(userOnboardingProgress).where(eq(userOnboardingProgress.userId, userId))
}

/** An unfinished guide's place, or null when it has none yet. */
export async function readOnboardingProgress(userId: string): Promise<OnboardingProgress | null> {
  const [row] = await db.select({ step: userOnboardingProgress.step, status: userOnboardingProgress.status })
    .from(userOnboardingProgress).where(eq(userOnboardingProgress.userId, userId)).limit(1)
  return row ? normalizeProgress(row) : null
}

/** Saves where the guide is; the latest save wins, from any device. */
export async function saveOnboardingProgress(userId: string, value: unknown) {
  const progress = normalizeProgress(value)
  const status = Object.fromEntries(Object.entries(progress.status).map(([key, item]) => [String(key), item]))
  await db.insert(userOnboardingProgress).values({ userId, step: progress.step, status, updatedAt: new Date() })
    .onConflictDoUpdate({ target: userOnboardingProgress.userId, set: { step: progress.step, status, updatedAt: new Date() } })
  return progress
}

export async function setupChecklistDismissed(userId: string, workspaceId: string) {
  const [row] = await db.select({ userId: setupChecklistDismissals.userId }).from(setupChecklistDismissals)
    .where(and(eq(setupChecklistDismissals.userId, userId), eq(setupChecklistDismissals.workspaceId, workspaceId))).limit(1)
  return Boolean(row)
}

export async function dismissSetupChecklist(userId: string, workspaceId: string) {
  await db.insert(setupChecklistDismissals).values({ userId, workspaceId }).onConflictDoNothing()
}

/** Reveals this person's checklist again in just this workspace. Item completion is derived by the next read. */
export async function restoreSetupChecklist(userId: string, workspaceId: string) {
  await db.delete(setupChecklistDismissals)
    .where(and(eq(setupChecklistDismissals.userId, userId), eq(setupChecklistDismissals.workspaceId, workspaceId)))
}
