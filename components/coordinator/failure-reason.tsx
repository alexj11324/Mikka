'use client'

import { useTranslations } from 'next-intl'
import { CircleAlert } from 'lucide-react'
import type { ChatFailure } from '@/lib/chat-failure'

const TRANSIENT = new Set(['usage_in_progress', 'usage_concurrency_limit', 'usage_cost_unavailable'])

/**
 * Why an earlier turn did not answer this message, under it for good: the
 * same words as the line it had when it failed, without its actions, which
 * belong only to the newest failure.
 */
export function FailureReason({ failure }: { failure: ChatFailure }) {
  const chat = useTranslations('Coordinator')
  const billing = useTranslations('Billing.refusal')
  const reason = failure.kind === 'hosted'
    ? TRANSIENT.has(failure.code) ? billing('unavailable') : failure.code === 'verification_required' ? billing('verificationRequiredPlain') : billing(failure.code as 'free_allowance_used' | 'points_exhausted' | 'platform_paused')
    : failure.kind === 'subscription' ? chat(`subscriptionRefusal.${failure.notice}`)
      : failure.kind === 'wake' ? chat(`wakeErrors.${failure.code}`) : chat('failedTitle')
  return <p data-message-failure="past" className="flex items-center gap-1.5 text-xs text-muted-foreground">
    <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />{reason}
  </p>
}
