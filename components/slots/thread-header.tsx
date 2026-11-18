'use client'

// The default thread-header slot (docs/ui-overlay.md): the thread panel's header row and status line as the
// community layer draws them.
import { useFormatter, useTranslations } from 'next-intl'
import { ArrowLeft, Ellipsis, Square, SquareKanban, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ThreadStatus } from '@/components/workspace/thread-status-icon'
import { cn } from '@/lib/utils'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { ThreadHeaderProps, ThreadStatusLineProps } from './thread-header-contract'

export function ThreadHeader({ title, viewTitle, headingRef, onBack, onClose, onStop, onOpenTask, place, acceptanceBadge, identity, views = [] }: ThreadHeaderProps) {
  const t = useTranslations('IssueThreads')
  const nav = useTranslations('Nav')
  return <header className={cn('flex h-12 shrink-0 items-center gap-2 border-b border-rule px-4', onBack && 'pl-2')}>
    {onBack && <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="shrink-0" aria-label={t('back')} aria-keyshortcuts="Escape" onClick={onBack} />}><ArrowLeft data-icon="inline-start" /></TooltipTrigger><TooltipContent side="bottom">{t('back')}</TooltipContent></Tooltip>}
    <h2 ref={headingRef} tabIndex={-1} className="min-w-0 truncate text-sm font-semibold outline-none">{viewTitle ?? title}</h2>
    {/* Icons only after the title: where it runs and its Agent; names on hover (Alex, 2026-11-06). */}
    {place}
    {acceptanceBadge}
    <span className="flex-1" />
    {identity}
    {/* Stop lives here for every live run, also one waiting for an answer, whose composer button sends. */}
    {onStop && <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground" aria-label={t('stop')} data-slot="thread-stop" onClick={onStop} />}><Square data-icon="inline-start" className="fill-current" /></TooltipTrigger><TooltipContent side="bottom">{t('stop')}</TooltipContent></Tooltip>}
    {onOpenTask && <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground" aria-label={t('openTask')} onClick={onOpenTask} />}><SquareKanban data-icon="inline-start" /></TooltipTrigger><TooltipContent side="bottom">{t('openTask')}</TooltipContent></Tooltip>}
    {views.length > 0 && <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={nav('more')} />}><Ellipsis /></DropdownMenuTrigger>
      <DropdownMenuContent align="end">{views.map(view => <DropdownMenuItem key={view.id} onClick={view.onSelect}>{view.label}</DropdownMenuItem>)}</DropdownMenuContent>
    </DropdownMenu>}
    {onClose && <Button variant="ghost" size="icon-sm" aria-label={t('close')} onClick={onClose}><X data-icon="inline-start" /></Button>}
  </header>
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
