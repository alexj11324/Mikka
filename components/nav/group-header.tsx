import type { ReactNode } from 'react'
import { Separator } from '@/components/ui/separator'

/**
 * A group's header in the right column: muted 「等待回复（2）」, then a thin
 * rule to the edge (Figma 395:27702, Alex 2026-10-28). Exempt from
 * style/no-horizontal-rule, like the 「新」 unread divider.
 */
export function GroupHeader({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-3 px-2 py-1 text-xs text-muted-foreground">
    <span className="flex shrink-0 items-center gap-1">{children}</span>
    <Separator className="flex-1" />
  </div>
}
