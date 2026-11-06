'use client'

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** A message folds once taller than this (px), to `max-h-60` (240px), so 显示更多 never opens a single line. */
export const MESSAGE_FOLD_AFTER = 320
const FOLDED = 'max-h-60 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]'

/**
 * A long message folded to its first lines with 显示更多 / 收起 under it, as Claude.ai
 * and ChatGPT fold a long prompt. Only messages taller than MESSAGE_FOLD_AFTER fold; the
 * measure follows the content's own size (ResizeObserver), never a timer.
 */
export function CollapsibleMessage({ children }: { children: ReactNode }) {
  const t = useTranslations('Common')
  const frame = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const [long, setLong] = useState(false)
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => {
    const element = content.current
    if (!element) return
    const measure = () => setLong(element.scrollHeight > MESSAGE_FOLD_AFTER)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const folded = long && !open
  return <div data-slot="collapsible-message" data-folded={folded ? '' : undefined} className="flex min-w-0 flex-col">
    <div ref={frame} className={cn('min-w-0', folded && FOLDED)}>
      <div ref={content} className="flex min-w-0 flex-col gap-1.5">{children}</div>
    </div>
    {long && <Button type="button" variant="link" size="xs" aria-expanded={open} className="h-auto self-start px-0 pt-1 text-current underline underline-offset-2 opacity-80 hover:opacity-100"
      onClick={() => {
        setOpen(value => !value)
        // Folding a message read to its end brings its start back into view, not the next message.
        if (open) requestAnimationFrame(() => frame.current?.scrollIntoView({ block: 'nearest' }))
      }}>{open ? t('showLess') : t('showMore')}</Button>}
  </div>
}
