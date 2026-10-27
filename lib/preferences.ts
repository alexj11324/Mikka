import 'server-only'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { PUSH_WHEN, userPreferences } from '@/lib/db/schema'
import { attentionEnabled, setAttentionEnabled } from '@/lib/attention/store'

/**
 * The app's 通知 and 记忆 settings (docs/design/mobile.md, "Settings").
 * `proactive` (主动消息) is lib/attention's switch, kept in attention_settings;
 * the rest live in user_preferences.
 */
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
  const [[row], proactive] = await Promise.all([
    db.select().from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1),
    attentionEnabled(userId),
  ])
  if (!row) return { ...DEFAULT_PREFERENCES, proactive }
  const { userId: _user, updatedAt: _at, ...stored } = row
  return { ...stored, proactive }
}

export async function savePreferences(userId: string, patch: z.infer<typeof preferencesPatch>): Promise<Preferences> {
  const { proactive, ...rest } = patch
  if (proactive !== undefined) await setAttentionEnabled(userId, proactive)
  const { proactive: _proactive, ...stored } = { ...await readPreferences(userId), ...rest }
  await db.insert(userPreferences).values({ userId, ...stored, updatedAt: new Date() })
    .onConflictDoUpdate({ target: userPreferences.userId, set: { ...stored, updatedAt: new Date() } })
  return readPreferences(userId)
}
