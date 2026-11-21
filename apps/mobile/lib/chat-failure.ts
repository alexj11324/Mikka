import type { ChatFailure } from './types'
import { mobileMessages } from './messages'
import { subscriptionRecovery, type SubscriptionRefusalNotice } from '../../../lib/subscription-refusal'
import type { CloudErrorCode } from '../../../lib/cloud-services/errors'

const F = mobileMessages.MobileCore.failure
const RUN_ERRORS = mobileMessages.RunErrors
const SUBSCRIPTION_LINES = {
  unavailable: F.subUnavailable, reconnect: F.subReconnect, quotaUsed: F.subQuotaUsed, retry: F.subRetry,
  selectionChanged: F.subSelectionChanged, rateLimited: F.subRateLimited, accessDenied: F.subAccessDenied,
  modelRejected: F.modelRejected, quotaChecking: F.quotaChecking, runtimeUnavailable: F.runtimeUnavailable,
  modelNotReported: F.modelNotReported,
} satisfies Record<SubscriptionRefusalNotice, string>

interface FailureLine { text: string; retry: boolean; recovery: 'models' | 'model' | 'billing' | 'cloudBilling' | null }
const CLOUD_RECOVERY = {
  cloud_not_connected: 'model', cloud_scope_missing: 'model', cloud_server_revoked: 'model',
  cloud_invalid_request: 'model', cloud_access_denied: 'model', cloud_quota_exhausted: 'cloudBilling',
  cloud_rate_limited: 'retry', cloud_unavailable: 'retry',
} satisfies Record<CloudErrorCode, 'model' | 'cloudBilling' | 'retry'>

/**
 * A failed reply's line on the phone, in the web chat's words
 * (messages/zh-CN.json Coordinator.subscriptionRefusal, wakeErrors, failedTitle;
 * Billing hosted refusals), with the web's same recovery. A wake the server
 * is still retrying offers no 重试. Unknown newer codes stay readable.
 */
export function failureLine(failure: ChatFailure): FailureLine {
  if (failure.kind === 'failed' && failure.cloudCode && Object.hasOwn(CLOUD_RECOVERY, failure.cloudCode)) {
    const recovery = CLOUD_RECOVERY[failure.cloudCode], retry = recovery === 'retry'
    return { text: RUN_ERRORS[failure.cloudCode].default, retry,
      recovery: recovery === 'retry' ? null : recovery }
  }
  switch (failure.kind) {
    case 'subscription': {
      if (!Object.hasOwn(SUBSCRIPTION_LINES, failure.notice)) return { text: SUBSCRIPTION_LINES.retry, retry: true, recovery: null }
      const recovery = subscriptionRecovery(failure.notice)
      return { text: SUBSCRIPTION_LINES[failure.notice], retry: recovery === 'retry', recovery: recovery === 'retry' ? null : recovery === 'settings' ? 'models' : 'model' }
    }
    case 'hosted': {
      const lines: Record<string, string> = { verification_required: F.hostedQuotaUsed, free_allowance_used: F.hostedQuotaUsed, points_exhausted: F.hostedQuotaUsed, platform_paused: F.hostedPaused }
      const recovery = failure.code === 'platform_paused' ? 'model' : Object.hasOwn(lines, failure.code) ? 'billing' : null
      return { text: lines[failure.code] ?? F.temporarilyUnavailable, retry: recovery === null, recovery }
    }
    case 'wake': return {
      text: { wake_failed: F.wakeWaiting, wake_start_unconfirmed: F.wakeUnconfirmed, wake_exhausted: F.wakeExhausted }[failure.code],
      retry: failure.code === 'wake_exhausted', recovery: null,
    }
    case 'failed': return failure.reason === 'modelRequired'
      ? { text: mobileMessages.Coordinator.modelRequired, retry: false, recovery: 'models' }
      : failure.reason === 'balance'
      ? { text: F.apiBalance, retry: false, recovery: 'model' }
      : failure.reason === 'tools' ? { text: F.replyIncomplete, retry: true, recovery: null }
      : { text: F.replyFailed, retry: true, recovery: null }
  }
}

/** Billing belongs to the selected workspace; subscription accounts are personal. */
export function failureSettingsPath(section: 'models' | 'billing', workspaceId?: string): string | null {
  const workspace = workspaceId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceId) ? workspaceId.toLowerCase() : null
  if (section === 'billing' && !workspace) return null
  return `/settings?section=${section}${workspace ? `&workspace=${workspace}` : ''}`
}
