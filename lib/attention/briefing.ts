import 'server-only'
import { wakeCoordinator } from '@/lib/coordinator/wake'
import { briefingHighlights, todaysBriefing } from '@/lib/suggestions/store'
import { higherLevel, type AttentionLevel } from './judgment'
import { queueBriefing } from './store'

/**
 * Hands the person's 08:00 briefing to their Coordinator (R-20), which tells
 * them only when an item needs them today. Call it from the briefing job once
 * the person's local 08:00 has passed; it writes today's briefing if none
 * exists yet and is safe to call again (one handoff per local day). Returns
 * whether a briefing was queued: false on a day with nothing to say, when it
 * was already queued, or when the person turned matters off.
 */
export async function handBriefingToCoordinator(userId: string, timeZone: string | null): Promise<boolean> {
  const briefing = await todaysBriefing(userId, timeZone)
  if (!briefing) return false
  const items = await briefingHighlights(userId, briefing.highlights)
  const level = items.reduce<AttentionLevel>((top, item) => item.level ? higherLevel(top, item.level) : top, 'normal')
  const queued = await queueBriefing(userId, {
    localDate: briefing.localDate, total: briefing.total,
    items: items.map(item => ({ title: item.title, source: item.source, level: item.level, url: item.url, actor: item.actor })),
  }, level)
  if (!queued) return false
  await wakeCoordinator(userId)
  return true
}
