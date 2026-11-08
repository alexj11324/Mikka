'use client'

// The default thread-card slot (docs/ui-overlay.md): what a reply dispatched, as a card in the chat.
import { useTranslations } from 'next-intl'
import { ChevronRight } from 'lucide-react'
import { runThreadName, type RunSource } from '@/lib/coordinator/citations'
import { machineName, runInfoParts } from '@/lib/run-info-view'
import { Button } from '@/components/ui/button'
import { PullRequestsBadge } from '@/components/workspace/pull-requests-badge'
import { ThreadStatus, ThreadStatusIcon } from '@/components/workspace/thread-status-icon'
import { cn } from '@/lib/utils'
import { THREAD_CARD, THREAD_CARD_BUTTON } from '@/components/coordinator/thread-card-style'
import type { ThreadCardProps } from '@/components/slots/thread-card-contract'
import { ReviewSummaryLine } from '@ui-slot/review-summary'
import { openReview } from '@/hooks/code-review/use-review-page'


/** R-66 review frame 356:4750: status and title, then the PRs it produced as one badge; one card per thread. A thread with no task opens too. */
export function ThreadCard({ run, onOpen }: ThreadCardProps) {
  const t = useTranslations('IssueThreads')
  const name = runThreadName(run)
  return <div data-slot="thread-card" className={cn(THREAD_CARD, 'max-w-md')}>
    <Button variant="ghost" className={THREAD_CARD_BUTTON} aria-label={t('open', { name })} onClick={() => onOpen({ issueId: run.issue?.id ?? null, runId: run.id })} />
    <ThreadStatusIcon status={run.status} outcome={run.outcome} />
    <div className="pointer-events-none relative flex min-w-0 flex-1 flex-col gap-2">
      <span className="truncate text-sm leading-5 font-medium">{name}</span>
      {run.info && <RunInfoLine info={run.info} />}
      {/* A coding task's summary line and 审阅 (R0); the default slot draws nothing. */}
      {run.issue && <ReviewSummaryLine taskId={run.issue.id} placement="card" onOpenReview={openReview} />}
    </div>
    {/* The state's word beside its bubble and dot: icon, colour and word together (R-87). */}
    <span className="pointer-events-none relative shrink-0"><ThreadStatus status={run.status} outcome={run.outcome} icon={false} /></span>
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
