import type { CoordinatorEventKind, CoordinatorEventTier } from '@/lib/db/schema'

/**
 * Why a Coordinator reply may go to the person's phone, one per 通知 setting
 * (docs/design/mobile.md): 需要你决策, 待审阅, 线程完成, 每日简报.
 */
export type PushReason = 'decide' | 'review' | 'finished' | 'briefing'

interface InboxEvent { kind: CoordinatorEventKind; tier: CoordinatorEventTier | null }

/**
 * The reasons the events a turn answers give for pushing its reply. A reply
 * to the person's own message is never pushed: they are in the chat (R-20,
 * only the Coordinator tells the person, and only what it raises itself).
 */
export function pushReasons(events: readonly InboxEvent[]): PushReason[] {
  if (events.some(event => event.kind === 'user_message')) return []
  const reasons = new Set<PushReason>()
  for (const event of events) {
    if (event.tier === 'attention') reasons.add('decide')
    else if (event.tier === 'result' && (event.kind === 'run_finished' || event.kind === 'artifact_submitted')) reasons.add('finished')
  }
  return [...reasons]
}
