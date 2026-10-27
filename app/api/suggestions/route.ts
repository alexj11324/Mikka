import { after, NextResponse } from 'next/server'
import { getSession } from '@/lib/session'
import type { SuggestionSource } from '@/lib/db/schema'
import { ACTION_LOCALES, type ActionLocale } from '@/lib/suggestions/action-title'
import { rememberLocale } from '@/lib/suggestions/action-title-server'
import { ensureComposioTriggers } from '@/lib/suggestions/sources'
import { briefingHighlights, listSuggestions, todaysBriefing } from '@/lib/suggestions/store'

export const runtime = 'nodejs'

const headers = { 'Cache-Control': 'private, no-store' }

/**
 * The suggestions list: today's briefing (null on a day with nothing to say)
 * and the shown suggestions grouped by source app. `tz` is the person's IANA
 * time zone; without it the visitor's location decides. `locale` is the UI
 * language, remembered so new items' action lines (R-41) are written in it.
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
  const timeZone = params.get('tz') ?? request.headers.get('x-vercel-ip-timezone')
  const locale = params.get('locale')
  if (locale && (ACTION_LOCALES as readonly string[]).includes(locale)) {
    after(async () => {
      try { await rememberLocale(user.id, locale as ActionLocale) }
      catch (error) { console.error('Remembering the locale failed', error instanceof Error ? error.message : error) }
    })
  }
  const [briefing, items] = await Promise.all([todaysBriefing(user.id, timeZone), listSuggestions(user.id)])
  const groups = new Map<SuggestionSource, typeof items>()
  for (const item of items) groups.set(item.source, [...groups.get(item.source) ?? [], item])
  const view = (item: (typeof items)[number]) => ({ id: item.id, source: item.source, action: item.action, title: item.title, actionTitle: item.actionTitle, url: item.url, actor: item.actor, required: item.required, occurredAt: item.occurredAt })
  return NextResponse.json({
    briefing: briefing && {
      kind: briefing.kind, localDate: briefing.localDate, counts: briefing.counts, total: briefing.total,
      highlights: (await briefingHighlights(user.id, briefing.highlights)).map(view),
    },
    groups: [...groups].map(([source, list]) => ({ source, items: list.map(view) })),
  }, { headers })
}
