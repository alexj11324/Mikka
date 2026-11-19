'use client'

import { cloneElement, isValidElement, useId, type ReactNode } from 'react'
import { cn } from 'cn'

/**
 * Why a control is disabled, for the person who cannot press it.
 *
 * A disabled button takes no pointer events, so the reason cannot be a child of
 * the control: it goes on this wrapper as `title` for a pointer, and as
 * `aria-describedby` on the control itself — cloned onto it, because ARIA does
 * not inherit that attribute from an ancestor. A screen reader therefore reads
 * the reason with the button instead of leaving the reader to guess.
 *
 * Pass `reason` only when there is a real cause. A control disabled because the
 * form is not filled in yet needs no prose: `reason` undefined renders the
 * children untouched.
 */
export function WhyDisabled({ reason, fill = false, children }: { reason?: string | null; fill?: boolean; children: ReactNode }) {
  const id = useId()
  if (!reason) return <>{children}</>
  const control = isValidElement<{ 'aria-describedby'?: string }>(children)
    ? cloneElement(children, { 'aria-describedby': [children.props['aria-describedby'], id].filter(Boolean).join(' ') })
    : children
  return (
    <span title={reason} className={cn('inline-flex flex-col gap-1', fill && 'w-full')}>
      <span className={cn('inline-flex', fill && 'w-full')}>{control}</span>
      <span id={id} className="sr-only">{reason}</span>
    </span>
  )
}
