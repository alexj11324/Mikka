import { cn } from '@/lib/utils'
import { markOfValue, stateMarkTone } from '@/lib/state-mark'
import { statusDots } from '@/lib/status-appearance'

/**
 * The 8px dot in front of a task or a run. Its colour is the one its mark has (`stateMarkTone`), so the dot and the
 * status chip on the same row can never say two different things.
 */
export function StatusDot({ status }: { status: string }) {
  return <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', statusDots[stateMarkTone(markOfValue(status))])} />
}
