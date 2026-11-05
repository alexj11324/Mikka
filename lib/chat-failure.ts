import { hostedRefusal } from '@/lib/billing/hosted-usage'
import { subscriptionRefusal, type SubscriptionRefusalNotice } from '@/lib/subscription-refusal'
import { chatBalanceRefusal } from '@/lib/chat-balance'

/**
 * Why a chat's last reply did not come, as the web's chat reads it
 * (components/coordinator/coordinator-chat.tsx): Mikka 默认 refused it, the
 * chosen subscription refused it, the wake is still being retried or gave up,
 * or the turn failed, or ended with no reply. Null while a turn is working or
 * nothing failed. The iOS
 * app draws its line and 重试 from this, never the raw error.
 */
type WakeCode = 'wake_failed' | 'wake_start_unconfirmed' | 'wake_exhausted'

export type ChatFailure =
  | { kind: 'hosted'; code: NonNullable<ReturnType<typeof hostedRefusal>> }
  | { kind: 'subscription'; notice: NonNullable<ReturnType<typeof subscriptionRefusal>> }
  | { kind: 'wake'; code: WakeCode }
  // Keep the existing discriminator readable by already-installed mobile clients.
  | { kind: 'failed'; reason?: 'balance' }

export function chatFailure(chat: { working: boolean; error: string | null; items?: readonly { from: string; pending?: true }[] }): ChatFailure | null {
  if (chat.working) return null
  // A turn that ended with no reply and nothing recorded (its lease ran out): the person's message is the newest.
  if (!chat.error) return chat.items?.findLast(item => item.from !== 'event')?.from === 'person' && !chat.items.at(-1)?.pending ? { kind: 'failed' } : null
  const hosted = hostedRefusal(chat.error)
  if (hosted) return { kind: 'hosted', code: hosted }
  const notice = subscriptionRefusal(chat.error)
  if (notice) return { kind: 'subscription', notice }
  if (chat.error === 'wake_failed' || chat.error === 'wake_start_unconfirmed' || chat.error === 'wake_exhausted') return { kind: 'wake', code: chat.error }
  if (chatBalanceRefusal(chat.error)) return { kind: 'failed', reason: 'balance' }
  return { kind: 'failed' }
}

const TRANSIENT_HOSTED = new Set(['usage_in_progress', 'usage_concurrency_limit', 'usage_cost_unavailable'])

/** Where a failure's words live in messages/*.json: the web line, Telegram and the phone all read this one key. */
export type FailureMessageKey =
  | { namespace: 'Billing.refusal'; key: 'unavailable' | 'verificationRequiredPlain' | 'free_allowance_used' | 'points_exhausted' | 'platform_paused' }
  | { namespace: 'Coordinator'; key: `subscriptionRefusal.${SubscriptionRefusalNotice}` | `wakeErrors.${WakeCode}` | 'failedTitle' | 'apiBalance' }

export function failureMessageKey(failure: ChatFailure): FailureMessageKey {
  switch (failure.kind) {
    case 'hosted':
      return { namespace: 'Billing.refusal', key: TRANSIENT_HOSTED.has(failure.code) ? 'unavailable' : failure.code === 'verification_required' ? 'verificationRequiredPlain' : failure.code as 'free_allowance_used' | 'points_exhausted' | 'platform_paused' }
    case 'subscription': return { namespace: 'Coordinator', key: `subscriptionRefusal.${failure.notice}` }
    case 'wake': return { namespace: 'Coordinator', key: `wakeErrors.${failure.code}` }
    default: return { namespace: 'Coordinator', key: failure.reason === 'balance' ? 'apiBalance' : 'failedTitle' }
  }
}
