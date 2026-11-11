import { hostedRefusal } from '@/lib/billing/hosted-usage'
import { subscriptionRefusal, type SubscriptionRefusalNotice } from '@/lib/subscription-refusal'
import { chatBalanceRefusal } from '@/lib/chat-balance'
import { cloudErrorCode, type CloudErrorCode } from '@/lib/cloud-services/errors'
import { parseCodedErrorText } from '@mikka/protocol/coded-error'
import { readRunFailure, type RunFailure } from '@mikka/protocol/run-failure'

/**
 * Why a chat's last reply did not come, as the web's chat reads it
 * (components/coordinator/coordinator-chat.tsx): Mikka 默认 refused it, the
 * chosen subscription refused it, the wake is still being retried or gave up,
 * or the turn failed, or ended with no reply. Null while a turn is working or
 * nothing failed. The iOS
 * app draws its line and 重试 from this, never the raw error.
 */
type WakeCode = 'wake_failed' | 'wake_start_unconfirmed' | 'wake_exhausted'

export type ChatFailure = (
  | { kind: 'hosted'; code: NonNullable<ReturnType<typeof hostedRefusal>> }
  | { kind: 'subscription'; notice: NonNullable<ReturnType<typeof subscriptionRefusal>> }
  | { kind: 'wake'; code: WakeCode }
  // Keep the existing discriminator readable by already-installed mobile clients.
  | { kind: 'failed'; reason?: 'balance' | 'tools'; cloudCode?: CloudErrorCode }
  // The stored code(s) as recorded, for 详情 only (decision 2026-11-05-0330): the
  // line's own code, then the turn failure behind a wake code. Never the words.
) & { raw?: string; failureDetails?: RunFailure }

export function chatFailure(chat: { working: boolean; error: string | null; cause?: string | null; failureDetails?: unknown; items?: readonly { from: string; pending?: true }[] }): ChatFailure | null {
  const details = chat.working || !chat.error ? null : readRunFailure(chat.failureDetails)
  const legacy = failureOf(chat) ?? (details ? { kind: 'failed' as const } : null)
  const failure = legacy && details ? { ...legacy, failureDetails: details } : legacy
  if (!failure || !chat.error) return failure
  // A stored code (with its detail) always goes; other text only when nothing else names the failure,
  // so a recognised provider refusal does not carry its request ids along (the phone contract).
  const unknown = failure.kind === 'failed' && !failure.reason
  const lines = [...new Set([chat.error, chat.cause].flatMap(line => {
    const text = line?.trim()
    const code = text ? CODE.exec(text)?.[1] : undefined
    return code ? [code] : text && unknown ? [text] : []
  }))]
  return lines.length ? { ...failure, raw: lines.join('\n') } : failure
}

// The code alone, or ending a wrapped message (`Error: …`, `Step "…" failed after 3 retries: …`).
const CODE = /(?:^|: )([a-z][a-z0-9_]*(?: \([a-z][a-z0-9_]*\))?)$/
// The model streaming boundary stores its closed refusal inside this SDK
// envelope. Presentation only: tool text and other workflow steps do not
// establish a cloud refusal, provider fallback or credential health.
const CLOUD_STREAM_STEP = /^Step "step\/\/@ai-sdk\/workflow@\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?(?:\+[a-z0-9.-]+)?\/\/doStreamStep" failed after \d+ retries:\s*/

function failureOf(chat: { working: boolean; error: string | null; items?: readonly { from: string; pending?: true }[] }): ChatFailure | null {
  if (chat.working) return null
  // A turn that ended with no reply and nothing recorded (its lease ran out): the person's message is the newest.
  if (!chat.error) return chat.items?.findLast(item => item.from !== 'event')?.from === 'person' && !chat.items.at(-1)?.pending ? { kind: 'failed' } : null
  const cloudCode = cloudErrorCode(parseCodedErrorText(chat.error.trim().replace(CLOUD_STREAM_STEP, ''))?.code)
  if (cloudCode) return { kind: 'failed', cloudCode }
  const hosted = hostedRefusal(chat.error)
  if (hosted) return { kind: 'hosted', code: hosted }
  const notice = subscriptionRefusal(chat.error)
  if (notice) return { kind: 'subscription', notice }
  if (chat.error === 'wake_failed' || chat.error === 'wake_start_unconfirmed' || chat.error === 'wake_exhausted') return { kind: 'wake', code: chat.error }
  if (chatBalanceRefusal(chat.error)) return { kind: 'failed', reason: 'balance' }
  if (chat.error === 'model_tool_unavailable') return { kind: 'failed', reason: 'tools' }
  return { kind: 'failed' }
}

const TRANSIENT_HOSTED = new Set(['usage_in_progress', 'usage_concurrency_limit', 'usage_cost_unavailable'])

/** Where a failure's words live in messages/*.json: the web line, Telegram and the phone all read this one key. */
export type FailureMessageKey =
  | { namespace: 'Billing.refusal'; key: 'unavailable' | 'verificationRequiredPlain' | 'free_allowance_used' | 'points_exhausted' | 'platform_paused' | 'usage_budget_exhausted' | 'billing_authorization_revoked' }
  | { namespace: 'Coordinator'; key: `subscriptionRefusal.${SubscriptionRefusalNotice}` | `wakeErrors.${WakeCode}` | 'failedTitle' | 'apiBalance' | 'replyToolUnavailable' }
  | { namespace: 'RunErrors'; key: `${CloudErrorCode}.default` }

export function failureMessageKey(failure: ChatFailure): FailureMessageKey {
  switch (failure.kind) {
    case 'hosted':
      return { namespace: 'Billing.refusal', key: TRANSIENT_HOSTED.has(failure.code) ? 'unavailable' : failure.code === 'verification_required' ? 'verificationRequiredPlain' : failure.code as 'free_allowance_used' | 'points_exhausted' | 'platform_paused' | 'usage_budget_exhausted' | 'billing_authorization_revoked' }
    case 'subscription': return { namespace: 'Coordinator', key: `subscriptionRefusal.${failure.notice}` }
    case 'wake': return { namespace: 'Coordinator', key: `wakeErrors.${failure.code}` }
    default: return failure.cloudCode ? { namespace: 'RunErrors', key: `${failure.cloudCode}.default` } : { namespace: 'Coordinator', key: failure.reason === 'balance' ? 'apiBalance' : failure.reason === 'tools' ? 'replyToolUnavailable' : 'failedTitle' }
  }
}
