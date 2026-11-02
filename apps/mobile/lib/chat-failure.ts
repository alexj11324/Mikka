import type { ChatFailure } from '@/lib/types'

/**
 * A failed reply's line on the phone, in the web chat's words
 * (messages/zh-CN.json Coordinator.subscriptionRefusal, wakeErrors, failedTitle;
 * Billing hosted refusals), whether 重试 applies, and whether the way on is
 * 设置 › 模型与额度. A wake the server is still retrying offers no 重试.
 */
export function failureLine(failure: ChatFailure): { text: string; retry: boolean; settings: boolean } {
  switch (failure.kind) {
    case 'subscription': return {
      text: { unavailable: '所选订阅不可用', reconnect: '订阅需要重新连接', quotaUsed: '订阅额度已用完', retry: '订阅暂时不可用' }[failure.notice],
      retry: true, settings: failure.notice !== 'retry',
    }
    case 'hosted': {
      const lines: Record<string, string> = { verification_required: '使用 Mikka 默认模型前需要验证银行卡', free_allowance_used: '免费额度已用完', points_exhausted: '点数已用完', platform_paused: '免费额度暂时停用' }
      return { text: lines[failure.code] ?? 'Mikka 默认模型暂时不可用', retry: true, settings: failure.code in lines }
    }
    case 'wake': return {
      text: { wake_failed: '回复等待重试', wake_start_unconfirmed: '回复启动未确认', wake_exhausted: '回复重试已停止' }[failure.code],
      retry: failure.code === 'wake_exhausted', settings: false,
    }
    case 'failed': return { text: '回复失败', retry: true, settings: false }
  }
}
