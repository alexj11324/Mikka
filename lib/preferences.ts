import 'server-only'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { PUSH_WHEN, userPreferences } from '@/lib/db/schema'

/** The app's 通知 and 记忆 settings (docs/design/mobile.md, "Settings"). */
export interface Preferences {
  proactive: boolean
  pushDecide: boolean
  pushReview: boolean
  pushFinished: boolean
  pushBriefing: boolean
  pushWhen: (typeof PUSH_WHEN)[number]
  memoryEnabled: boolean
}

export const DEFAULT_PREFERENCES: Preferences = {
  proactive: true, pushDecide: true, pushReview: true, pushFinished: false, pushBriefing: true, pushWhen: 'always', memoryEnabled: true,
}

export const preferencesPatch = z.object({
  proactive: z.boolean(), pushDecide: z.boolean(), pushReview: z.boolean(), pushFinished: z.boolean(), pushBriefing: z.boolean(),
  pushWhen: z.enum(PUSH_WHEN), memoryEnabled: z.boolean(),
}).partial().strict()

/** The person's settings; the defaults when they never changed one. */
export async function readPreferences(userId: string): Promise<Preferences> {
  const [row] = await db.select().from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1)
  if (!row) return DEFAULT_PREFERENCES
  const { userId: _user, updatedAt: _at, ...preferences } = row
  return preferences
}

export async function savePreferences(userId: string, patch: z.infer<typeof preferencesPatch>): Promise<Preferences> {
  const next = { ...await readPreferences(userId), ...patch }
  await db.insert(userPreferences).values({ userId, ...next, updatedAt: new Date() })
    .onConflictDoUpdate({ target: userPreferences.userId, set: { ...next, updatedAt: new Date() } })
  return next
}
