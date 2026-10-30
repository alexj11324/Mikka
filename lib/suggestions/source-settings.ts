import 'server-only'
import { eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { userPreferences } from '@/lib/db/schema'
import { COMPOSIO_APP_IDS, type ComposioAppId } from '@/lib/composio-accounts'

// Which connected Composio apps feed 建议 and the daily briefing
// (docs/settings-backend/prefs.md). Stored per person in
// user_preferences."suggestionSources" as { app: false } for each app turned
// off; every app is on by default. GitHub and Linear are not Composio apps and
// are not switched here.

export const SUGGESTION_SOURCE_APPS = COMPOSIO_APP_IDS
export type SuggestionSourceApp = ComposioAppId

export function isSuggestionSourceApp(value: unknown): value is SuggestionSourceApp {
  return typeof value === 'string' && (SUGGESTION_SOURCE_APPS as readonly string[]).includes(value)
}

/** The apps the person turned off as a suggestions source. */
export async function disabledSuggestionSources(userId: string): Promise<Set<SuggestionSourceApp>> {
  const [row] = await db.select({ sources: userPreferences.suggestionSources }).from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1)
  return new Set(Object.entries(row?.sources ?? {}).flatMap(([app, enabled]) => enabled === false && isSuggestionSourceApp(app) ? [app] : []))
}

/** Turns one app on or off as a source; other apps keep their setting. */
export async function writeSuggestionSource(userId: string, app: SuggestionSourceApp, enabled: boolean): Promise<void> {
  const patch = JSON.stringify({ [app]: enabled })
  await db.insert(userPreferences).values({ userId, suggestionSources: { [app]: enabled }, updatedAt: new Date() })
    .onConflictDoUpdate({ target: userPreferences.userId, set: { suggestionSources: sql`${userPreferences.suggestionSources} || ${patch}::jsonb`, updatedAt: new Date() } })
}

/**
 * Drops notifications from apps their person turned off. Anything that is not
 * a switchable app (GitHub, Linear) always passes.
 */
export async function keepEnabledSources<T extends { userId: string; source: string }>(notifications: readonly T[]): Promise<T[]> {
  const switchable = notifications.filter(item => isSuggestionSourceApp(item.source))
  if (!switchable.length) return [...notifications]
  const people = [...new Set(switchable.map(item => item.userId))]
  const disabled = new Map(await Promise.all(people.map(async userId => [userId, await disabledSuggestionSources(userId)] as const)))
  return notifications.filter(item => !disabled.get(item.userId)?.has(item.source as SuggestionSourceApp))
}
