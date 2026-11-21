'use client'

import { X } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * One condition that is in effect, said where it is read: `field is value` with
 * its own remove. The shape is the one `docs/design/components.md` already fixed
 * for the board toolbar — one `--control` container, the same 28px height and 8px
 * radius as the `sm` buttons beside it, never a group of separate blocks.
 *
 * It exists because the same chip had been written out by hand twice (the PR
 * directory and the automations list), each with its own `h-6` / `rounded-md`,
 * which is 24px and 6px against the 28px and 8px the row is drawn on. Both
 * copies also sat outside `badge-size.ts` and the control-size policy, so the
 * guards that exist to keep one baseline stayed green while the rows drifted.
 *
 * A chip whose condition has no value (`created by me`) passes no `value` and
 * says only the field, the way Capy's boolean conditions do.
 */
export function FilterChip({ field, value, is, title, removeLabel, onRemove, disabled, className }: {
  field: string
  value?: string
  /** The word between field and value: 是 / is. Omitted for a condition with no value. */
  is?: string
  title?: string
  /** Read by assistive tech, so it has to name the condition being removed. */
  removeLabel: string
  onRemove: () => void
  disabled?: boolean
  className?: string
}) {
  return <span
    title={title}
    className={cn('inline-flex h-(--control-sm) min-w-0 max-w-full items-center gap-1 rounded-(--radius-control) bg-control ps-2 pe-0.5 text-xs', className)}
  >
    <span className="shrink-0 text-muted-foreground">{field}</span>
    {value !== undefined && <>
      {is && <span className="shrink-0 text-muted-foreground">{is}</span>}
      <span className="min-w-0 truncate font-medium text-foreground">{value}</span>
    </>}
    <Button variant="ghost" size="icon-xs" aria-label={removeLabel} disabled={disabled} onClick={onRemove} className="shrink-0 text-muted-foreground">
      <X data-icon />
    </Button>
  </span>
}
