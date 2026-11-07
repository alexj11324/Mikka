import type { ChatFailure } from './types'
import { subscriptionRecovery, type SubscriptionRefusalNotice } from '../../../lib/subscription-refusal'

const SUBSCRIPTION_LINES = {
  unavailable: '所选订阅不可用', reconnect: '订阅需要重新连接', quotaUsed: '订阅额度已用完', retry: '订阅暂时不可用',
  selectionChanged: '订阅选择已失效', rateLimited: '订阅请求受限', accessDenied: '服务商拒绝订阅访问',
  modelRejected: '模型请求被拒绝', quotaChecking: '订阅额度待确认', runtimeUnavailable: '当前环境不支持此订阅',
  modelNotReported: '云电脑没报告能跑这个模型',
} satisfies Record<SubscriptionRefusalNotice, string>

interface FailureLine { text: string; retry: boolean; recovery: 'models' | 'model' | 'billing' | null }

/**
 * A failed reply's line on the phone, in the web chat's words
 * (messages/zh-CN.json Coordinator.subscriptionRefusal, wakeErrors, failedTitle;
 * Billing hosted refusals), with the web's same recovery. A wake the server
 * is still retrying offers no 重试. Unknown newer codes stay readable.
 */
export function failureLine(failure: ChatFailure): FailureLine {
  switch (failure.kind) {
    case 'subscription': {
      if (!Object.hasOwn(SUBSCRIPTION_LINES, failure.notice)) return { text: SUBSCRIPTION_LINES.retry, retry: true, recovery: null }
      const recovery = subscriptionRecovery(failure.notice)
      return { text: SUBSCRIPTION_LINES[failure.notice], retry: recovery === 'retry', recovery: recovery === 'retry' ? null : recovery === 'settings' ? 'models' : 'model' }
    }
    case 'hosted': {
      const lines: Record<string, string> = { verification_required: '使用 Mikka 默认模型前需要验证银行卡', free_allowance_used: '免费额度已用完', points_exhausted: '点数已用完', platform_paused: '免费额度暂时停用' }
      const recovery = failure.code === 'platform_paused' ? 'model' : Object.hasOwn(lines, failure.code) ? 'billing' : null
      return { text: lines[failure.code] ?? 'Mikka 默认模型暂时不可用', retry: recovery === null, recovery }
    }
    case 'wake': return {
      text: { wake_failed: '回复等待重试', wake_start_unconfirmed: '回复启动未确认', wake_exhausted: '回复重试已停止' }[failure.code],
      retry: failure.code === 'wake_exhausted', recovery: null,
    }
    case 'failed': return failure.reason === 'balance'
      ? { text: 'API 余额不足', retry: false, recovery: 'model' }
      : failure.reason === 'tools' ? { text: '这次回复没能完成，请重试', retry: true, recovery: null }
      : { text: '回复失败', retry: true, recovery: null }
  }
}

/** Billing belongs to the selected workspace; subscription accounts are personal. */
export function failureSettingsPath(section: 'models' | 'billing', workspaceId?: string): string | null {
  const workspace = workspaceId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceId) ? workspaceId.toLowerCase() : null
  if (section === 'billing' && !workspace) return null
  return `/settings?section=${section}${workspace ? `&workspace=${workspace}` : ''}`
}
