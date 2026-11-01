'use client'

import { useEffect, useLayoutEffect, useRef } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { findThreadIssue } from '@/app/actions/agents'
import { Skeleton } from '@/components/ui/skeleton'
import { ResizeHandle } from '@/components/ui/resizable-pane'
import { PANEL_WIDTH } from '@/components/nav/context-panel'
import { useResizableWidth } from '@/hooks/use-resizable-width'
import { cn } from '@/lib/utils'
import { IssueThreadPanel } from './issue-thread-panel'
import { closeThread, navigate, openThread } from './workspace-navigation'

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
export function ThreadColumn({ runId, issueId: known }: { runId: string; issueId?: string | null }) {
  const t = useTranslations('IssueThreads')
  const tPanel = useTranslations('Shell.panel')
  const { data: looked, isLoading } = useSWR(known ? null : ['thread-issue', runId], () => findThreadIssue(runId))
  // A thread with no task opens too, on its own conversation; it just has no task to link to.
  const thread = known ? { issueId: known } : looked
  // A thread the viewer may not read is not a place: show what is there instead.
  useEffect(() => { if (!known && !isLoading && looked === null) navigate({ thread: null }, 'replace') }, [known, isLoading, looked])
  const issueId = thread?.issueId ?? null
  const resize = useResizableWidth(PANEL_WIDTH)
  const ref = useRef<HTMLElement>(null)
  useLayoutEffect(() => { ref.current?.style.setProperty('--thread-column-width', `${resize.width}px`) }, [resize.width])
  return <aside ref={ref} aria-label={tPanel('label')} data-slot="thread-column" className={cn(
    'flex min-h-0 flex-col bg-background',
    'max-xl:fixed max-xl:inset-0 max-xl:z-30 md:max-xl:left-auto md:max-xl:w-[min(100%,28rem)] md:max-xl:border-l md:max-xl:shadow-lg',
    'xl:relative xl:w-(--thread-column-width) xl:shrink-0 xl:border-l',
    resize.dragging && 'select-none',
  )}>
    <ResizeHandle resize={resize} label={tPanel('resize')} edge="start" className="hidden xl:block" />
    {thread
      ? <IssueThreadPanel key={runId} issueId={issueId} runId={runId} onClose={closeThread} onOpenThread={openThread} onOpenTask={issueId ? () => navigate({ issue: issueId, thread: runId }) : undefined} />
      : <div role="status" aria-label={t('loading')} className="flex flex-col gap-3 p-4"><Skeleton className="h-6 w-2/3" /><Skeleton className="h-24 w-full" /></div>}
  </aside>
}
