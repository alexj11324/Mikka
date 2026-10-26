'use client'

import { useTranslations } from 'next-intl'
import { ArrowDown, ArrowUp, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { formatCount } from '@/lib/unread'
import { cn } from 'cn'

/** MIK-8 「↑/↓ N 条新消息 ×」 pill: default small Buttons; the body jumps, × only dismisses. */
export function UnreadPill({ direction, count, onJump, onDismiss }: { direction: 'up' | 'down'; count: number; onJump: () => void; onDismiss: () => void }) {
  const t = useTranslations('Unread')
  const label = t(direction === 'up' ? 'jumpToUnread' : 'jumpToLatest', { count, display: formatCount(count) })
  return <div data-unread-pill={direction} className={cn('absolute inset-x-0 z-10 flex justify-center', direction === 'up' ? 'top-2' : 'bottom-2')}>
    <ButtonGroup>
      <Button size="sm" onClick={onJump}>{direction === 'up' ? <ArrowUp data-icon="inline-start" /> : <ArrowDown data-icon="inline-start" />}{label}</Button>
      <Button size="icon-sm" aria-label={t('dismiss')} onClick={onDismiss}><X data-icon="inline-start" /></Button>
    </ButtonGroup>
  </div>
}
