'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { retryCoordinatorTurn } from '@/app/actions/coordinator'
import { Button } from '@/components/ui/button'

/**
 * 重试 beside a failed reply, in the Coordinator's and every bot's chat: runs
 * the same turn again for the message already sent. One run per click; the
 * chat then shows its normal working state.
 */
export function RetryReplyButton({ botId, onQueued }: { botId: string | null; onQueued: () => unknown }) {
  const t = useTranslations('Common')
  const [pending, setPending] = useState(false)
  async function retry() {
    if (pending) return
    setPending(true)
    try {
      const result = botId ? await retryCoordinatorTurn(botId) : await retryCoordinatorTurn()
      if (!result.error) await onQueued()
    } finally { setPending(false) }
  }
  return <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => void retry()}>{t('retry')}</Button>
}
