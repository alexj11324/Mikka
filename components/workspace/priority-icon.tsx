import { Mark } from '@/components/workspace/state-mark'
import { priorityMarkOf } from '@/lib/state-mark'

/**
 * A priority's mark, from the one registry (`lib/state-mark.ts`): 紧急 is the amber square with its point cut out,
 * the rest Linear's three bars at heights 4 / 7.5 / 11. Board cards, the list and the property menus share it (R-25),
 * so a priority is drawn once and coloured once.
 */
export function PriorityIcon({ priority, label }: { priority: string; label?: string }) {
  const mark = priorityMarkOf(priority)
  const a11y = label ? { role: 'img' as const, 'aria-label': label, 'aria-hidden': false as const } : {}
  return <Mark {...a11y} shape={mark.shape} tone={mark.tone} data-priority={priority} />
}
