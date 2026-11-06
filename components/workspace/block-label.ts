import type { useTranslations } from 'next-intl'
import type { TaskBlock } from '@/lib/task-blocked'

/** How a card or a list row names why a task is 受阻 (`Shell.board.card.block.*`). */
export function blockLabel(tCard: ReturnType<typeof useTranslations<'Shell.board.card'>>, block: TaskBlock): string {
  return block.reason === 'dependency' && block.blockerIdentifier
    ? tCard('block.dependencyOn', { id: block.blockerIdentifier })
    : tCard(`block.${block.reason}`)
}
