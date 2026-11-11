'use client'

import { useTranslations } from 'next-intl'
import { ListTree } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { ThreadOutlineEntry } from '@/lib/thread-outline'

/**
 * The jump index for a long thread: one row per thing a person said, and
 * clicking a row scrolls that message into view.
 *
 * It is a popover rather than a sidebar on purpose. ALE-40 is a jump index,
 * not a navigation panel: it should be there when a reader is looking for a
 * moment and out of the way otherwise, and a permanent column would take width
 * from the conversation it is meant to help read.
 *
 * Its anchors are the `data-thread-item` ids the list already carries, so the
 * index and the list cannot disagree about which row is which. Positions are
 * never used: a jump to the wrong message is worse than no jump.
 */
export function ThreadOutlineIndex({ entries }: { entries: readonly ThreadOutlineEntry[] }) {
  const t = useTranslations('IssueThreads')
  if (entries.length < 2) return null
  const reveal = (id: string) => {
    // The transcript is the popover's sibling under the same scroll root.
    const row = document.querySelector(`[data-thread-item="${CSS.escape(id)}"]`)
    row?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }
  return <Popover>
    <PopoverTrigger render={<Button variant="ghost" size="xs" data-slot="thread-outline-index"
      aria-label={t('outlineIndex', { count: entries.length })}
      className="shrink-0 gap-1 px-1.5 text-xs text-muted-foreground" />}>
      <ListTree aria-hidden="true" />{entries.length}
    </PopoverTrigger>
    <PopoverContent align="end" className="flex max-h-80 w-72 flex-col gap-1 overflow-y-auto p-2">
      <ol className="flex flex-col">
        {entries.map(entry => <li key={entry.id}>
          <button type="button" onClick={() => reveal(entry.id)}
            className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-start outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
            <span className="flex min-w-0 items-baseline justify-between gap-2">
              <span className="truncate text-xs font-medium text-foreground">{entry.author || t('outlineUnknownAuthor')}</span>
              {entry.mine && <span className="shrink-0 text-xs text-muted-foreground">{t('outlineYou')}</span>}
            </span>
            <span className="line-clamp-2 text-xs text-muted-foreground">{entry.text}</span>
          </button>
        </li>)}
      </ol>
    </PopoverContent>
  </Popover>
}
