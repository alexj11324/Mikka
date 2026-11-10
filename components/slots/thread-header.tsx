'use client'

// The default thread-header slot (docs/ui-overlay.md): the thread panel's header row and status line as the
// community layer draws them.
import { useFormatter, useTranslations } from 'next-intl'
import { ArrowLeft, Square, SquareKanban, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ThreadStatus } from '@/components/workspace/thread-status-icon'
import { cn } from '@/lib/utils'
import type { ThreadHeaderProps, ThreadStatusLineProps } from './thread-header-contract'

export function ThreadHeader({ title, headingRef, onBack, onClose, onStop, onOpenTask, place, acceptanceBadge, mode, identity, artifact, tabs, wraps }: ThreadHeaderProps) {
  const t = useTranslations('IssueThreads')
  // The header lives in a resizable right column, so its narrow layout follows
  // the column's own width, never the viewport: a 1440 px window still opens a
  // 320–360 px column. The wrapper is the query container and the header is its
  // child, because a container query cannot size the container itself.
  return <div data-slot="thread-header-container" className="@container/thread-header w-full min-w-0 shrink-0">
    <header className={cn('flex h-12 items-center gap-2 border-b border-rule px-4', onBack && 'pl-2', wraps && '@max-[22rem]/thread-header:h-auto @max-[22rem]/thread-header:flex-wrap @max-[22rem]/thread-header:py-2')}>
      {onBack && <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="shrink-0" aria-label={t('back')} aria-keyshortcuts="Escape" onClick={onBack} />}><ArrowLeft data-icon="inline-start" /></TooltipTrigger><TooltipContent side="bottom">{t('back')}</TooltipContent></Tooltip>}
      <h2 ref={headingRef} tabIndex={-1} className="min-w-0 truncate text-sm font-semibold outline-none">{title}</h2>
      {/* Icons only after the title: where it runs and its Agent; names on hover (Alex, 2026-11-06). */}
      {place}
      {acceptanceBadge}
      {/* The mode control the panel renders (#1730): the owner's picker, laid out here only. */}
      {mode && <div data-slot="thread-mode-slot" className={cn('flex min-w-0 items-center', wraps ? '@max-[22rem]/thread-header:order-last @max-[22rem]/thread-header:w-full' : 'shrink-0')}>{mode}</div>}
      <span className="flex-1" />
      {identity}
      {/* Always there, left of stop: off until the thread hands an Artifact over (decision 2026-11-06-1615). */}
      {artifact}
      {/* Stop lives here for every live run, also one waiting for an answer, whose composer button sends. */}
      {onStop && <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground" aria-label={t('stop')} data-slot="thread-stop" onClick={onStop} />}><Square data-icon="inline-start" className="fill-current" /></TooltipTrigger><TooltipContent side="bottom">{t('stop')}</TooltipContent></Tooltip>}
      {onOpenTask && <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground" aria-label={t('openTask')} onClick={onOpenTask} />}><SquareKanban data-icon="inline-start" /></TooltipTrigger><TooltipContent side="bottom">{t('openTask')}</TooltipContent></Tooltip>}
      {/* Frame 06 draws the machine in the wide centre-column header; the side panel has no room for it. */}
      {tabs}
      {onClose && <Button variant="ghost" size="icon-sm" aria-label={t('close')} onClick={onClose}><X data-icon="inline-start" /></Button>}
    </header>
  </div>
}

export function ThreadStatusLine({ status, outcome, stopping, waiting, startedAt, dispatchedBy }: ThreadStatusLineProps) {
  const t = useTranslations('IssueThreads')
  const format = useFormatter()
  return <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
    <ThreadStatus status={status} outcome={outcome} stopping={stopping} waiting={waiting} />
    <span>{t('started', { time: format.dateTime(new Date(startedAt), { hour: '2-digit', minute: '2-digit' }) })}</span>
    {/* The bot that dispatched it, also when it is not the chat beside it (R-78, R-82). */}
    {dispatchedBy && <span>{dispatchedBy} {t('dispatched')}</span>}
  </div>
}
