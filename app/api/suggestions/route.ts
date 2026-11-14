import { NextResponse } from 'next/server'
import { afterJob } from '@/lib/background'
import { pool } from '@/lib/db'
import { getApiSession } from '@/lib/api-auth'
import type { SuggestionSource } from '@/lib/db/schema'
import { ACTION_LOCALES, type ActionLocale } from '@/lib/suggestions/action-title'
import { rememberLocale } from '@/lib/suggestions/action-title-server'
import { ensureComposioTriggers } from '@/lib/suggestions/sources'
import { listSuggestions, recordTimeZone, todaysBriefing } from '@/lib/suggestions/store'
import { manualTimeZone } from '@/lib/suggestions/time-zone'

export const runtime = 'nodejs'

const headers = { 'Cache-Control': 'private, no-store' }

/** The suggestions already handed over (an execution exists), by id: the list leaves them out of its groups. */
async function startedSuggestions(userId: string, ids: string[]) {
  const executions = ids.length ? (await pool.query('SELECT "suggestionId",status,"runId","subagentId" FROM suggestion_executions WHERE "ownerId"=$1 AND "suggestionId"=ANY($2::uuid[])', [userId, ids])).rows : []
  return new Map(executions.map(row => [row.suggestionId as string, row]))
}

/**
 * The suggestions list: the shown suggestions grouped by source app. The
 * daily briefing is not part of it; the Coordinator delivers it in its chat
 * (R-21). Reading the list still writes the day's briefing if the briefings
 * cron has not. The committed event wakes the Coordinator. `tz` is the person's
 * IANA time zone, remembered so the cron writes at 08:00 their time; without
 * it the visitor's location decides. A zone the person picked in Settings
 * ('manual') is used instead and is not replaced.
 * `locale` is the UI language, remembered so new items' action lines (R-45)
 * are written in it.
 */
export async function GET(request: Request) {
  const user = (await getApiSession({ headers: request.headers }))?.user
  if (!user) return NextResponse.json({ error: 'authRequired' }, { status: 401, headers })
  // `count=1`, the count on 收件箱: how many cards the list shows, read only. No briefing written, no Coordinator
  // woken, no trigger, zone or locale saved: a count shown on every page must change nothing.
  if (new URL(request.url).searchParams.get('count') === '1') {
    const items = await listSuggestions(user.id)
    const started = await startedSuggestions(user.id, items.map(item => item.id))
    return NextResponse.json({ count: items.filter(item => !started.has(item.id)).length }, { headers })
  }
  // Hobby cron runs once a day, so opening the list is when a missing trigger gets re-created.
  afterJob('after:composio-triggers', async () => {
    try { await ensureComposioTriggers(user.id) }
    catch (error) { console.error('Composio trigger check failed', error instanceof Error ? error.message : error) }
  })
  const params = new URL(request.url).searchParams
  const browserTimeZone = params.get('tz')
  if (browserTimeZone) {
    afterJob('after:record-time-zone', async () => {
      try { await recordTimeZone(user.id, browserTimeZone) }
      catch (error) { console.error('Time zone could not be saved', error instanceof Error ? error.message : error) }
    })
  }
  const locale = params.get('locale')
  if (locale && (ACTION_LOCALES as readonly string[]).includes(locale)) {
    afterJob('after:remember-locale', async () => {
      try { await rememberLocale(user.id, locale as ActionLocale) }
      catch (error) { console.error('Remembering the locale failed', error instanceof Error ? error.message : error) }
    })
  }
  // A zone picked in Settings wins over what this browser or IP reports.
  const timeZone = await manualTimeZone(user.id) ?? browserTimeZone ?? request.headers.get('x-vercel-ip-timezone')
  const [, items] = await Promise.all([todaysBriefing(user.id, timeZone), listSuggestions(user.id)])
  const execution = await startedSuggestions(user.id, items.map(item => item.id))
  const groups = new Map<SuggestionSource, typeof items>()
  for (const item of items) if (!execution.has(item.id)) groups.set(item.source, [...groups.get(item.source) ?? [], item])
  const view = (item: (typeof items)[number]) => ({ id: item.id, source: item.source, action: item.action, title: item.title, actionTitle: item.actionTitle, url: item.url, actor: item.actor, required: item.required, occurredAt: item.occurredAt })
  return NextResponse.json({
    inProgress: items.filter(item => ['starting', 'running'].includes(execution.get(item.id)?.status)).map(item => ({ ...view(item), state: execution.get(item.id)?.status, runId: execution.get(item.id)?.runId, subagentId: execution.get(item.id)?.subagentId })),
    groups: [...groups].map(([source, list]) => ({ source, items: list.map(view) })),
  }, { headers })
}
