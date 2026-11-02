'use client'

import { useTranslations } from 'next-intl'
import { CircleAlert } from 'lucide-react'
import { failureMessageKey, type ChatFailure } from '@/lib/chat-failure'

/**
 * Why an earlier turn did not answer this message, under it for good: the
 * same words as the line it had when it failed, without its actions, which
 * belong only to the newest failure. Telegram and the phone read the same key
 * (failureMessageKey, lib/coordinator/refusal-line.ts).
 */
export function FailureReason({ failure }: { failure: ChatFailure }) {
  const chat = useTranslations('Coordinator')
  const billing = useTranslations('Billing.refusal')
  const message = failureMessageKey(failure)
  const reason = message.namespace === 'Billing.refusal' ? billing(message.key) : chat(message.key)
  return <p data-message-failure="past" className="flex items-center gap-1.5 text-xs text-muted-foreground">
    <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />{reason}
  </p>
}
