import type { SubscriptionRefusalCode } from '@mikka/protocol/subscription'

/** Every subscription refusal code, grouped by what the person can do about it. */
const REFUSALS = {
  binding_required: 'unavailable', account_unavailable: 'unavailable', binding_mismatch: 'unavailable',
  stale_binding: 'unavailable', disconnected: 'unavailable', provider_approval_required: 'unavailable',
  isolation_required: 'unavailable', billing_unverified: 'unavailable',
  pending_auth: 'reconnect', reconnect_required: 'reconnect',
  quota_exhausted: 'quotaUsed',
  quota_unknown: 'retry', backend_unavailable: 'retry',
} as const satisfies Record<SubscriptionRefusalCode, string>

export type SubscriptionRefusalNotice = (typeof REFUSALS)[SubscriptionRefusalCode]

// The code alone, or ending a wrapped message; never a word inside an unrelated error.
const pattern = new RegExp(`^(?:[^]*: )?(${Object.keys(REFUSALS).join('|')})$`)

/**
 * The notice for a turn the chosen subscription refused, or null. The code is
 * the whole failure message, or inside an older retried step's message
 * (`Step "…" failed after 3 retries: binding_required`).
 */
export function subscriptionRefusal(message: string | null | undefined): SubscriptionRefusalNotice | null {
  const match = message ? pattern.exec(message.trim()) : null
  return match ? REFUSALS[match[1] as SubscriptionRefusalCode] : null
}
