'use client'

import { TaskConversation } from '@ui-slot/task-conversation'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { findThreadIssue } from '@/app/actions/agents'
import { Skeleton } from '@/components/ui/skeleton'
import { InlineLoadError } from '@/components/load-error'
import { readAccessFailure } from '@/lib/swr/persistent-cache'
import { ResizeHandle } from '@/components/ui/resizable-pane'
import { PANEL_WIDTH } from '@/components/nav/context-panel'
import { useResizableWidth } from '@/hooks/use-resizable-width'
import { usePanelInitialWidth, useWidenToggle } from '@/hooks/use-panel-width'
import { cn } from '@/lib/utils'
import { IssueThreadPanel } from './issue-thread-panel'
import { RightColumnWidenContext } from './right-column-widen'
import { closeThread, navigate, openThread, toggleAllThreads } from './workspace-navigation'

/** Task detail's own breakpoint: narrower, a thread open on the task covers it, so 打开任务 leaves the thread behind. */
const TASK_WIDE = '(min-width: 1024px)'

/**
 * An open thread, in the right column beside what is in the centre (R-82): it
 * takes 概览's place and width, and closing it brings 概览 back. Below xl,
 * where the column has no room, it covers the window; on a phone that is the
 * pushed page R-66 describes.
 *
 * `issueId` is the task the thread works on when the caller knows it (the
 * thread lists do); a thread opened from its address alone, or one with no
 * task, looks it up.
 */
export function ThreadColumn({ runId, issueId: known, overList = false, name }: { runId: string; issueId?: string | null; /** Opened from 全部线程: ← goes back to that list, ✕ closes both. */ overList?: boolean; /** Its row's name in the thread list, so the header reads the same. */ name?: string }) {
  const t = useTranslations('IssueThreads')
  const { data: looked, error, isLoading, mutate } = useSWR(known ? null : ['thread-issue', runId], () => findThreadIssue(runId))
  const [rejectedRun, setRejectedRun] = useState<string | null>(null)
  const refused = !!readAccessFailure(error) || error?.code === 'runNotFound' || error?.code === 'desktop_session_changed'
  useEffect(() => {
    if (refused) setRejectedRun(runId)
    else if (!error) setRejectedRun(null)
  }, [refused, error, runId])
  // A thread with no task opens too, on its own conversation; it just has no task to link to.
  const thread = known ? { issueId: known } : refused || (error && rejectedRun === runId) ? undefined : looked
  const backgroundFailed = Boolean(error && thread)
  const readFailedMessage = t('loadFailed'), retryLabel = t('retry')
  useEffect(() => {
    const notice = `thread-issue-read-${runId}`
    if (backgroundFailed) toast.error(readFailedMessage, { id: notice, duration: Infinity, action: { label: retryLabel, onClick: event => { event.preventDefault(); void mutate() } } })
    else toast.dismiss(notice)
    return () => { toast.dismiss(notice) }
  }, [backgroundFailed, runId, mutate, readFailedMessage, retryLabel])
  // A thread the viewer may not read is not a place: show what is there instead.
  useEffect(() => { if (!known && !isLoading && looked === null) navigate({ thread: null }, 'replace') }, [known, isLoading, looked])
  const issueId = thread?.issueId ?? null
  return <RightColumn slot="thread-column">
    {thread
      ? issueId
        ? <TaskConversation key={issueId} issueId={issueId} runId={runId} name={name} onBack={closeThread} onClose={overList ? () => toggleAllThreads(false) : undefined} onOpenThread={openThread} onOpenTask={() => navigate({ issue: issueId, thread: window.matchMedia(TASK_WIDE).matches ? runId : null })} />
        : <IssueThreadPanel key={runId} issueId={issueId} runId={runId} name={name} onBack={closeThread} onClose={overList ? () => toggleAllThreads(false) : undefined} onOpenThread={openThread} />
      : error ? <div className="p-4"><InlineLoadError message={readFailedMessage} retryLabel={retryLabel} onRetry={() => { void mutate() }} /></div>
      : <div role="status" aria-label={t('loading')} className="flex flex-col gap-3 p-4"><Skeleton className="h-6 w-2/3" /><Skeleton className="h-24 w-full" /></div>}
  </RightColumn>
}

/**
 * The right column's frame for a thread or 全部线程 (R-82): 概览's width, resizable
 * from its inner edge. Below xl it covers the window; on a phone that is a pushed page.
 * Its ⤢ (useRightColumnWiden) reaches the header of what it holds; the default headers do not draw it.
 */
export function RightColumn({ slot, children }: { slot: string; children: ReactNode }) {
  const tPanel = useTranslations('Shell.panel')
  // A UI layer may size the default from the main area (panel-header slot); a remembered width still wins.
  const resize = useResizableWidth({ ...PANEL_WIDTH, initial: usePanelInitialWidth(PANEL_WIDTH.initial) })
  const widen = useWidenToggle(resize)
  const { wide, onToggle } = widen
  const toggle = useMemo(() => ({ wide, onToggle }), [wide, onToggle])
  const ref = useRef<HTMLElement>(null)
  useLayoutEffect(() => { ref.current?.style.setProperty('--thread-column-width', `${resize.width}px`) }, [resize.width])
  return <aside ref={ref} aria-label={tPanel('label')} data-slot={slot} className={cn(
    'flex min-h-0 flex-col bg-background',
    'max-xl:fixed max-xl:inset-0 max-xl:z-30 md:max-xl:left-auto md:max-xl:w-[min(100%,28rem)] md:max-xl:border-l md:max-xl:shadow-lg',
    'xl:relative xl:w-(--thread-column-width) xl:shrink-0 xl:border-l',
    resize.dragging && 'select-none',
  )}>
    <ResizeHandle resize={resize} label={tPanel('resize')} edge="start" className="hidden xl:block" onDoubleClick={widen.reset} />
    <RightColumnWidenContext.Provider value={toggle}>{children}</RightColumnWidenContext.Provider>
  </aside>
}
