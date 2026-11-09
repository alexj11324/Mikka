import 'server-only'
import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { attentionSettings, PUSH_WHEN, userPreferences } from '@/lib/db/schema'
import { SEND_KEYS } from '@/lib/send-key'
import { ActionFailureError } from '@/lib/action-error'
import { setAttentionEnabled } from '@/lib/attention/store'

/**
 * The app's 通知, 偏好 and 记忆 settings (docs/design/mobile.md, "Settings";
 * docs/settings-backend/prefs.md). `proactive` (主动消息) is lib/attention's
 * switch, kept in attention_settings; the rest live in user_preferences.
 * user_preferences."suggestionSources" is not part of this shape; it has its
 * own reader (lib/suggestions/source-settings.ts).
 */
export interface Preferences {
  proactive: boolean
  pushDecide: boolean
  pushReview: boolean
  pushFinished: boolean
  pushBriefing: boolean
  pushWhen: (typeof PUSH_WHEN)[number]
  memoryEnabled: boolean
  sendKey: (typeof SEND_KEYS)[number]
  personalInstructions: string
  /** 每日建议. Always false while memoryEnabled is false. */
  dailySuggestions: boolean
}

export const DEFAULT_PREFERENCES: Preferences = {
  proactive: true, pushDecide: true, pushReview: true, pushFinished: true, pushBriefing: true, pushWhen: 'always', memoryEnabled: true,
  sendKey: 'enter', personalInstructions: '', dailySuggestions: true,
}

/** Longest the personal instructions may be, in characters (code points). */
export const PERSONAL_INSTRUCTIONS_MAX = 2000

export const personalInstructionsSchema = z.string().transform(text => text.trim())
  .refine(text => [...text].length <= PERSONAL_INSTRUCTIONS_MAX, { message: 'personalInstructionsTooLong' })

export const preferencesPatch = z.object({
  proactive: z.boolean(), pushDecide: z.boolean(), pushReview: z.boolean(), pushFinished: z.boolean(), pushBriefing: z.boolean(),
  pushWhen: z.enum(PUSH_WHEN), memoryEnabled: z.boolean(),
  sendKey: z.enum(SEND_KEYS), personalInstructions: personalInstructionsSchema, dailySuggestions: z.boolean(),
}).partial().strict()

export type PreferencesPatch = z.infer<typeof preferencesPatch>

/**
 * Parses a patch from a client. A failure is an ActionFailureError:
 * personalInstructionsTooLong for long instructions, validationGeneric for anything else.
 */
export function parsePreferencesPatch(input: unknown): PreferencesPatch {
  const parsed = preferencesPatch.safeParse(input)
  if (parsed.success) return parsed.data
  const tooLong = parsed.error.issues.some(issue => issue.path[0] === 'personalInstructions' && issue.message === 'personalInstructionsTooLong')
  throw new ActionFailureError(tooLong ? 'personalInstructionsTooLong' : 'validationGeneric')
}

export type CoordinatorPromptPreferences = Pick<Preferences, 'memoryEnabled' | 'personalInstructions'>

/** Fresh prompt input only; notification and attention settings are not part of a model prompt. */
export async function readCoordinatorPromptPreferences(userId: string): Promise<CoordinatorPromptPreferences> {
  const [row] = await db.select({
    memoryEnabled: userPreferences.memoryEnabled,
    personalInstructions: userPreferences.personalInstructions,
  }).from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1)
  return row ?? {
    memoryEnabled: DEFAULT_PREFERENCES.memoryEnabled,
    personalInstructions: DEFAULT_PREFERENCES.personalInstructions,
  }
}

/** The person's settings; the defaults when they never changed one. */
export async function readPreferences(userId: string): Promise<Preferences> {
  // Anchor both optional rows to the same owner without reading the user table.
  // LEFT JOIN retains each table's defaults when only the other row exists.
  const [settings] = await db.select({ preferences: userPreferences, proactive: attentionSettings.enabled })
    .from(sql`(values (${userId}::text)) as preference_owner("userId")`)
    .leftJoin(userPreferences, sql`${userPreferences.userId} = preference_owner."userId"`)
    .leftJoin(attentionSettings, sql`${attentionSettings.userId} = preference_owner."userId"`)
  const row = settings?.preferences
  const proactive = settings?.proactive ?? true
  if (!row) return { ...DEFAULT_PREFERENCES, proactive }
  const { userId: _user, updatedAt: _at, suggestionSources: _sources, ...stored } = row
  return { ...stored, dailySuggestions: stored.dailySuggestions && stored.memoryEnabled, proactive }
}

/**
 * Saves a patch and returns all settings. 每日建议 needs 记忆: turning 记忆 off
 * turns it off too, and turning it on while 记忆 is off is refused with
 * dailySuggestionsNeedMemory.
 */
export async function savePreferences(userId: string, patch: PreferencesPatch): Promise<Preferences> {
  const { proactive, ...rest } = patch
  const current = await readPreferences(userId)
  const memoryEnabled = rest.memoryEnabled ?? current.memoryEnabled
  if (rest.dailySuggestions && !memoryEnabled) throw new ActionFailureError('dailySuggestionsNeedMemory')
  if (proactive !== undefined) await setAttentionEnabled(userId, proactive)
  const { proactive: _proactive, ...merged } = { ...current, ...rest }
  const stored = { ...merged, dailySuggestions: merged.dailySuggestions && memoryEnabled }
  await db.insert(userPreferences).values({ userId, ...stored, updatedAt: new Date() })
    .onConflictDoUpdate({ target: userPreferences.userId, set: { ...stored, updatedAt: new Date() } })
  return readPreferences(userId)
}
