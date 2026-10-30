'use client'

import type { ReactNode } from 'react'
import { useFormatter, useTranslations } from 'next-intl'

export function CardControlBoundary({ children }: { children: ReactNode }) {
  return <div data-card-control className="contents" onClick={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onTouchStart={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>{children}</div>
}

export function CardCreatedAt({ createdAt }: { createdAt: Date | string }) {
  const t = useTranslations('Issue')
  const format = useFormatter()
  const date = new Date(createdAt)
  return <time suppressHydrationWarning className="text-xs text-muted-foreground" dateTime={date.toISOString()} title={date.toISOString()}>{t('createdAtDate', { date: format.dateTime(date, { month: 'long', day: 'numeric' }) })}</time>
}
