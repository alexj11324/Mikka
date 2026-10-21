'use client'

import type { ReactNode } from 'react'

export function CardControlBoundary({ children }: { children: ReactNode }) {
  return <div data-card-control className="contents" onClick={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onTouchStart={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>{children}</div>
}

export function CardCreatedAt({ createdAt }: { createdAt: Date | string }) {
  const date = new Date(createdAt)
  return <time className="text-xs text-muted-foreground" dateTime={date.toISOString()} title={date.toISOString()}>创建于 {date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', timeZone: 'UTC' })}</time>
}
