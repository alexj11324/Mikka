import type { Preferences } from '@/lib/preferences'
import type { PushReason } from '@/lib/push-reasons'

const FLAG = { decide: 'pushDecide', review: 'pushReview', finished: 'pushFinished', briefing: 'pushBriefing' } as const satisfies Record<PushReason, keyof Preferences>

/**
 * Whether the person's 通知 settings let a reply with these reasons reach them.
 * Phone pushes and desktop notifications both follow it, so one switch covers
 * every device (Alex, 2026-10-31: 线程完成 goes to desktop and phone alike).
 */
export function pushAllowed(preferences: Pick<Preferences, 'proactive' | (typeof FLAG)[PushReason]>, reasons: readonly PushReason[]): boolean {
  return preferences.proactive && reasons.some(reason => preferences[FLAG[reason]] === true)
}
