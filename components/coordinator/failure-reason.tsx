'use client'

import { useTranslations } from 'next-intl'
import { CircleAlert } from 'lucide-react'
import type { ChatFailure } from '@/lib/chat-failure'
import { Button } from '@/components/ui/button'
import { Link } from '@/i18n/navigation'
import { settingsHref } from '@/lib/settings-sections'
import { openModelPicker } from './bot-model-picker'

const TRANSIENT = new Set(['usage_in_progress', 'usage_concurrency_limit', 'usage_cost_unavailable'])
const ACTION = 'h-auto px-0 py-0.5 text-xs text-foreground underline'

/**
 * Why an earlier turn did not answer this message, under it for good: the same words as the line it had when
 * it failed, and one way on (review C5, copy.md C-04): 充值 or 验证银行卡 when Mikka 默认 ran out, 换模型 when
 * the subscription or the platform refused it, else 重新发送, which sends the message again.
 */
export function FailureReason({ failure, botId, onResend, sending = false }: { failure: ChatFailure; botId: string | null; onResend: () => void; sending?: boolean }) {
  const chat = useTranslations('Coordinator')
  const billing = useTranslations('Billing')
  const picker = useTranslations('Coordinator.modelPicker')
  const transient = failure.kind === 'hosted' && TRANSIENT.has(failure.code)
  const reason = failure.kind === 'hosted'
    ? transient ? billing('refusal.unavailable') : failure.code === 'verification_required' ? billing('refusal.verificationRequiredPlain') : billing(`refusal.${failure.code as 'free_allowance_used' | 'points_exhausted' | 'platform_paused'}`)
    : failure.kind === 'subscription' ? chat(`subscriptionRefusal.${failure.notice}`)
      : failure.kind === 'wake' ? chat(`wakeErrors.${failure.code}`) : chat('failedTitle')
  const action = failure.kind === 'hosted' && !transient && failure.code !== 'platform_paused'
    ? <Button variant="link" size="xs" className={ACTION} nativeButton={false} role="link" render={<Link href={settingsHref('billing')} />}>{failure.code === 'verification_required' ? billing('refusal.verifyCard') : billing('balance.topUp')}</Button>
    : failure.kind === 'subscription' || (failure.kind === 'hosted' && failure.code === 'platform_paused')
      ? <Button variant="link" size="xs" className={ACTION} onClick={() => openModelPicker(botId)}>{picker('changeModel')}</Button>
      : <Button variant="link" size="xs" className={ACTION} disabled={sending} onClick={onResend}>{chat('resend')}</Button>
  return <p data-message-failure="past" className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
    <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />{reason}<span aria-hidden="true">·</span>{action}
  </p>
}
