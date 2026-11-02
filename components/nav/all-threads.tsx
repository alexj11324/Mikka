'use client'

import { MessagesSquare, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import type { listIssues } from '@/app/actions/issues'
import type { Thread } from '@/app/actions/task-runs'
import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { RightColumn } from '@/components/workspace/thread-column'
import { navigate, openThread, toggleAllThreads } from '@/components/workspace/workspace-navigation'
import { cn } from '@/lib/utils'
import { ThreadList } from './thread-list'

type Issue = Awaited<ReturnType<typeof listIssues>>[number]

/**
 * 全部线程's button, beside the globe in the window bar and in the phone's
 * header: the threads every bot dispatched, from any page, not only from a
 * bot's panel (R-82).
 */
export function AllThreadsToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const t = useTranslations('Shell.panel')
  return <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t('allThreads')} aria-pressed={open} onClick={onToggle}
    className={cn('text-muted-foreground', open && 'bg-muted text-foreground')} />}><MessagesSquare data-icon="inline-start" /></TooltipTrigger><TooltipContent side="bottom">{t('allThreads')}</TooltipContent></Tooltip>
}

/** The bots that dispatched these threads, each once, by name: the choices of 按派出者筛选. */
export function threadBots(threads: Thread[]) {
  const bots = new Map<string, string>()
  for (const thread of threads) if (thread.botId && !bots.has(thread.botId)) bots.set(thread.botId, thread.agentName)
  return [...bots].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 全部线程 in the right column (?threads=all, or ?threads=<bot> filtered to the
 * threads one bot dispatched): the threads every bot dispatched, in R-52's
 * groups; each row's second line opens with the mark of the Agent running it
 * (R-78) and 「<Bot> 派出」 (glossary: a bot dispatches a thread, an Agent runs it). A thread opens in this column; ← comes back here.
 */
export function AllThreadsColumn({ view, threads, issues }: { view: string; threads: Thread[]; issues: Issue[] }) {
  const t = useTranslations('Shell.panel')
  const bots = threadBots(threads)
  const bot = view === 'all' ? null : view
  const shown = bot ? threads.filter(thread => thread.botId === bot) : threads
  return <RightColumn slot="all-threads">
    <section aria-labelledby="all-threads-title" className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 px-4 pr-2">
        <h2 id="all-threads-title" className="min-w-0 flex-1 truncate text-sm font-semibold">{t('allThreads')}</h2>
        {/* A filter refines the same place: it replaces the address (R-82). */}
        {bots.length > 1 && <NativeSelect size="sm" aria-label={t('filterBot')} className="w-36" value={bot ?? 'all'} onChange={event => navigate({ threads: event.target.value }, 'replace')}>
          <NativeSelectOption value="all">{t('allBots')}</NativeSelectOption>
          {bots.map(item => <NativeSelectOption key={item.id} value={item.id}>{item.name}</NativeSelectOption>)}
        </NativeSelect>}
        <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t('closeAllThreads')} onClick={() => toggleAllThreads(false)} />}><X data-icon="inline-start" /></TooltipTrigger><TooltipContent side="bottom">{t('closeAllThreads')}</TooltipContent></Tooltip>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <ThreadList threads={shown} issues={issues} all onOpenThread={thread => openThread(thread.runId)} />
      </div>
    </section>
  </RightColumn>
}
