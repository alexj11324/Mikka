import { after, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import type { SuggestionSource } from '@/lib/db/schema'
import { ACTION_LOCALES, type ActionLocale } from '@/lib/suggestions/action-title'
import { rememberLocale } from '@/lib/suggestions/action-title-server'
import { ensureComposioTriggers } from '@/lib/suggestions/sources'
import { wakeCoordinator } from '@/lib/coordinator/wake'
import { listSuggestions, recordTimeZone, todaysBriefing } from '@/lib/suggestions/store'

export const runtime = 'nodejs'

const headers = { 'Cache-Control': 'private, no-store' }

/**
 * The suggestions list: the shown suggestions grouped by source app. The
 * daily briefing is not part of it; the Coordinator delivers it in its chat
 * (R-21). Reading the list still writes the day's briefing if the briefings
 * cron has not, and wakes the Coordinator to deliver it. `tz` is the person's
 * IANA time zone, remembered so the cron writes at 08:00 their time; without
 * it the visitor's location decides.
 * `locale` is the UI language, remembered so new items' action lines (R-45)
 * are written in it.
 */
export async function GET(request: Request) {
  const user = (await getSession())?.user
  if (!user) return NextResponse.json({ error: 'authRequired' }, { status: 401, headers })
  // Hobby cron runs once a day, so opening the list is when a missing trigger gets re-created.
  after(async () => {
    try { await ensureComposioTriggers(user.id) }
    catch (error) { console.error('Composio trigger check failed', error instanceof Error ? error.message : error) }
  })
  const params = new URL(request.url).searchParams
  const browserTimeZone = params.get('tz')
  if (browserTimeZone) {
    after(async () => {
      try { await recordTimeZone(user.id, browserTimeZone) }
      catch (error) { console.error('Time zone could not be saved', error instanceof Error ? error.message : error) }
    })
  }
  const locale = params.get('locale')
  if (locale && (ACTION_LOCALES as readonly string[]).includes(locale)) {
    after(async () => {
      try { await rememberLocale(user.id, locale as ActionLocale) }
      catch (error) { console.error('Remembering the locale failed', error instanceof Error ? error.message : error) }
    })
  }
  const timeZone = browserTimeZone ?? request.headers.get('x-vercel-ip-timezone')
  const [, items] = await Promise.all([todaysBriefing(user.id, timeZone, { onPushed: () => after(() => wakeCoordinator(user.id)) }), listSuggestions(user.id)])
  const groups = new Map<SuggestionSource, typeof items>()
  for (const item of items) groups.set(item.source, [...groups.get(item.source) ?? [], item])
  const view = (item: (typeof items)[number]) => ({ id: item.id, source: item.source, action: item.action, title: item.title, actionTitle: item.actionTitle, url: item.url, actor: item.actor, required: item.required, occurredAt: item.occurredAt })
  return NextResponse.json({
    groups: [...groups].map(([source, list]) => ({ source, items: list.map(view) })),
  }, { headers })
}
