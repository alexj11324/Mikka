'use client'

import { useTranslations } from 'next-intl'
import { ChevronRight } from 'lucide-react'
import type { RunSource } from '@/lib/coordinator/citations'
import { machineName, runInfoParts } from '@/lib/run-info-view'
import { Button } from '@/components/ui/button'
import { PullRequestsBadge } from '@/components/workspace/pull-requests-badge'
import { ThreadStatusIcon } from '@/components/workspace/thread-status-icon'
import { cn } from '@/lib/utils'

/** A thread as a card (R-66 frame 356:4750), shared by the chat and the thread list: the whole card opens it. */
export const THREAD_CARD = 'relative flex w-full items-center gap-3 rounded-xl bg-muted/60 px-3.5 py-3'
/** The card's full-size button; content above it does not take clicks. */
export const THREAD_CARD_BUTTON = 'absolute inset-0 size-full rounded-xl'

/** R-66 review frame 356:4750: status and title, then the PRs it produced as one badge; one card per thread. A thread with no task opens too. */
export function ThreadCard({ run, onOpen }: { run: RunSource; onOpen: (thread: { issueId: string | null; runId: string }) => void }) {
  const t = useTranslations('IssueThreads')
  return <div data-slot="thread-card" className={cn(THREAD_CARD, 'max-w-md')}>
    <Button variant="ghost" className={THREAD_CARD_BUTTON} aria-label={t('open', { name: run.name })} onClick={() => onOpen({ issueId: run.issue?.id ?? null, runId: run.id })} />
    <ThreadStatusIcon status={run.status} outcome={run.outcome} />
    <div className="pointer-events-none relative flex min-w-0 flex-1 flex-col gap-2">
      <span className="truncate text-sm leading-5 font-medium">{run.name}</span>
      {run.info && <RunInfoLine info={run.info} />}
    </div>
    {run.pullRequests && <PullRequestsBadge pullRequests={run.pullRequests} />}
    <ChevronRight aria-hidden="true" className="pointer-events-none relative size-4 shrink-0 text-muted-foreground" />
  </div>
}

/** 运行信息: one secondary line, only from what the run froze; a move adds 「已换到 … 继续」. */
function RunInfoLine({ info }: { info: NonNullable<RunSource['info']> }) {
  const t = useTranslations('IssueThreads.runInfo')
  const parts = runInfoParts(info, (owner, plan) => t('paidBy', { owner, plan }))
  if (!parts.length && !info.movedTo) return null
  return <span data-slot="run-info" className="truncate text-xs text-muted-foreground">
    {[parts.join(' · '), info.movedTo ? t('movedTo', { machine: machineName(info.movedTo) }) : null].filter(Boolean).join(' · ')}
  </span>
}
