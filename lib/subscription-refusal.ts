import type { SubscriptionRefusalCode } from '@mikka/protocol/subscription'

/** Every subscription refusal code, grouped by what the person can do about it. */
const REFUSALS = {
  binding_required: 'selectionChanged', account_unavailable: 'unavailable', binding_mismatch: 'selectionChanged',
  stale_binding: 'selectionChanged', disconnected: 'reconnect', provider_approval_required: 'runtimeUnavailable',
  isolation_required: 'runtimeUnavailable', billing_unverified: 'unavailable',
  pending_auth: 'reconnect', reconnect_required: 'reconnect',
  quota_exhausted: 'quotaUsed',
  quota_unknown: 'quotaChecking', backend_unavailable: 'retry',
  subscription_rate_limited: 'rateLimited', provider_access_denied: 'accessDenied',
  provider_request_rejected: 'modelRejected', provider_temporarily_unavailable: 'retry',
  provider_route_unavailable: 'runtimeUnavailable', invalid_credential_bundle: 'reconnect',
  subscription_timeout: 'retry', provider_operation_failed: 'retry',
  subscription_generation_failed: 'retry',
} as const satisfies Record<SubscriptionRefusalCode, string> & Record<string, string>

export type SubscriptionRefusalNotice = (typeof REFUSALS)[keyof typeof REFUSALS]

/** One recovery action shared by the live notice and a failed message's footer. */
export function subscriptionRecovery(notice: SubscriptionRefusalNotice): 'retry' | 'settings' | 'model' {
  if (notice === 'retry' || notice === 'rateLimited' || notice === 'quotaChecking') return 'retry'
  if (notice === 'reconnect' || notice === 'unavailable') return 'settings'
  return 'model'
}

// The code alone, or ending a wrapped message; never a word inside an unrelated error.
const pattern = new RegExp(`^(?:[^]*: )?(${Object.keys(REFUSALS).join('|')})$`)

/**
 * The notice for a turn the chosen subscription refused, or null. The code is
 * the whole failure message, or inside an older retried step's message
 * (`Step "…" failed after 3 retries: binding_required`).
 */
export function subscriptionRefusal(message: string | null | undefined): SubscriptionRefusalNotice | null {
  const match = message ? pattern.exec(message.trim()) : null
  return match ? REFUSALS[match[1] as keyof typeof REFUSALS] : null
}
