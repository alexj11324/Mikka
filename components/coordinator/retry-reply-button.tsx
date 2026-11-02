'use client'

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { retryCoordinatorTurn } from '@/app/actions/coordinator'
import { Button } from '@/components/ui/button'
import { useActionError } from '@/lib/use-action-error'

/**
 * 重试 beside a failed reply, in the Coordinator's and every bot's chat: runs
 * the same turn again for the message already sent. One run per click; the
 * chat then shows its normal working state.
 */
export function RetryReplyButton({ botId, onQueued, label, disabled }: { botId: string | null; onQueued: () => unknown; label?: string; disabled?: boolean }) {
  const t = useTranslations('Common')
  const feedbackText = useTranslations('Coordinator.replyRetry')
  const actionError = useActionError()
  const [pending, setPending] = useState(false)
  const inFlight = useRef(false)
  const [feedback, setFeedback] = useState<{ text: string; error: boolean } | null>(null)
  async function retry() {
    if (inFlight.current) return
    inFlight.current = true
    setPending(true)
    setFeedback(null)
    try {
      const result = botId ? await retryCoordinatorTurn(botId) : await retryCoordinatorTurn()
      if (result.error) {
        setFeedback({ text: actionError(result.error), error: true })
        return
      }
      setFeedback({ text: feedbackText(result.queued ? 'queued' : result.reason ?? 'nothingToRetry'), error: false })
      // A failed refresh cannot turn an acknowledged enqueue into an unknown
      // retry. The next normal chat refresh will show the same queued turn.
      try { await onQueued() } catch { /* keep the server's acknowledged result */ }
    } catch {
      setFeedback({ text: feedbackText('unconfirmed'), error: false })
    } finally { inFlight.current = false; setPending(false) }
  }
  return <span className="inline-flex min-w-0 flex-wrap items-center gap-2">
    <Button type="button" size="sm" variant="outline" disabled={pending || disabled} onClick={() => void retry()}>{label ?? t('retry')}</Button>
    {feedback && <span role={feedback.error ? 'alert' : 'status'} className="text-xs text-muted-foreground">{feedback.text}</span>}
  </span>
}
