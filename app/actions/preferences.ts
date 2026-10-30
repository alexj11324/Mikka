'use server'

import { headers } from 'next/headers'
import { z } from 'zod'
import { ActionFailureError, runAction } from '@/lib/action-error'
import type { ActionResult } from '@/lib/action-result'
import { notifiedToday } from '@/lib/attention/store'
import { auth } from '@/lib/auth'
import { parsePreferencesPatch, readPreferences, savePreferences, type Preferences } from '@/lib/preferences'
import { connectedComposioApps } from '@/lib/suggestions/sources'
import { disabledSuggestionSources, isSuggestionSourceApp, SUGGESTION_SOURCE_APPS, writeSuggestionSource, type SuggestionSourceApp } from '@/lib/suggestions/source-settings'
import { isIanaTimeZone, readTimeZoneSetting, writeTimeZoneSetting, type TimeZoneSetting } from '@/lib/suggestions/time-zone'

// Settings: 偏好设置, 通知 and 记忆与建议 (docs/settings-backend/prefs.md).
// Every action reads the signed-in person from the session; none takes a user id.

async function currentUserId(): Promise<string> {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new ActionFailureError('authRequired')
  return session.user.id
}

/** The notification, 偏好 and 记忆 settings the web Settings page shows (D16). */
export async function getPreferences(): Promise<Preferences> {
  return readPreferences(await currentUserId())
}

/**
 * Saves any of the settings and returns all of them. validationGeneric for a
 * malformed patch, personalInstructionsTooLong past 2000 characters,
 * dailySuggestionsNeedMemory when 每日建议 is turned on while 记忆 is off.
 */
export async function updatePreferences(patch: unknown): Promise<ActionResult<Preferences>> {
  return runAction(async () => {
    const userId = await currentUserId()
    return savePreferences(userId, parsePreferencesPatch(patch))
  })
}

/** 时区: the zone in force, whether the person picked it, and what the browser or IP last reported. */
export async function getTimeZoneSetting(): Promise<ActionResult<TimeZoneSetting>> {
  return runAction(async () => readTimeZoneSetting(await currentUserId()))
}

/** Picks an IANA zone, or 'auto' to follow the browser again. timeZoneInvalid for anything else. */
export async function setTimeZone(timeZone: unknown): Promise<ActionResult<TimeZoneSetting>> {
  return runAction(async () => {
    const userId = await currentUserId()
    if (timeZone !== 'auto' && !isIanaTimeZone(timeZone)) throw new ActionFailureError('timeZoneInvalid')
    return writeTimeZoneSetting(userId, timeZone)
  })
}

/** 提醒: how often the Coordinator told the person something in the last 24 hours, against the daily cap (lib/attention/budget.ts). */
export async function getAttentionToday(): Promise<ActionResult<{ notified: number; limit: number }>> {
  return runAction(async () => notifiedToday(await currentUserId()))
}

export interface SuggestionSourceView {
  app: SuggestionSourceApp
  connected: boolean
  enabled: boolean
}

/** 数据来源: every Composio app 建议 can read, whether the person connected it, and whether it is on. */
export async function listSuggestionSources(): Promise<ActionResult<{ sources: SuggestionSourceView[] }>> {
  return runAction(async () => {
    const userId = await currentUserId()
    const [connected, disabled] = await Promise.all([
      connectedComposioApps(userId).catch((error: unknown) => {
        console.error('Connected apps could not be read', error instanceof Error ? error.message : error)
        throw new ActionFailureError('generic')
      }),
      disabledSuggestionSources(userId),
    ])
    return { sources: SUGGESTION_SOURCE_APPS.map(app => ({ app, connected: connected.includes(app), enabled: !disabled.has(app) })) }
  })
}

/** Turns one app on or off as a source for 建议 and the daily briefing. suggestionSourceInvalid for an unknown app. */
export async function setSuggestionSource(app: unknown, enabled: unknown): Promise<ActionResult<{ app: SuggestionSourceApp; enabled: boolean }>> {
  return runAction(async () => {
    const userId = await currentUserId()
    if (!isSuggestionSourceApp(app)) throw new ActionFailureError('suggestionSourceInvalid')
    const parsed = z.boolean().safeParse(enabled)
    if (!parsed.success) throw new ActionFailureError('validationGeneric')
    await writeSuggestionSource(userId, app, parsed.data)
    return { app, enabled: parsed.data }
  })
}
