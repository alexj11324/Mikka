'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronRight } from 'lucide-react'
import type { RunSource } from '@/lib/coordinator/citations'
import { machineName, runInfoParts } from '@/lib/run-info-view'
import type { IssuePullRequest } from '@/lib/issue-metadata'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { PullRequestIcon } from '@/components/workspace/pull-request-icon'
import { ThreadStatusIcon } from '@/components/workspace/thread-status-icon'
import { PULL_REQUEST_COLORS } from '@/lib/pull-request-appearance'
import { cn } from '@/lib/utils'

const OUTPUT_CHIP = 'h-auto gap-1.25 rounded-md border-0 bg-card px-1.5 py-0.75 text-xs font-medium leading-4 [&>svg]:size-3.5!'

function ThreadOutputs({ pullRequests }: { pullRequests: IssuePullRequest[] }) {
  const t = useTranslations('IssueThreads')
  const stateLabel = useTranslations('Metadata.prState')
  const row = useRef<HTMLDivElement>(null)
  const measuring = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(Math.min(2, pullRequests.length))
  useEffect(() => {
    const container = row.current, probes = measuring.current
    if (!container || !probes) return
    const measure = () => {
      const widths = Array.from(probes.children).map(child => child.getBoundingClientRect().width)
      let count = Math.min(2, pullRequests.length)
      const needed = (n: number) => widths.slice(0, n).reduce((total, width) => total + width, 0) + Math.max(0, n - 1) * 6 + (n < pullRequests.length ? widths.at(-1)! + (n ? 6 : 0) : 0)
      while (count > 0 && needed(count) > container.clientWidth) count--
      setVisible(count)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    measure()
    void document.fonts.ready.then(measure)
    return () => observer.disconnect()
  }, [pullRequests])
  const hidden = pullRequests.length - visible
  const contents = (pr: IssuePullRequest) => <><PullRequestIcon state={pr.state} />{t('pullRequest', { number: pr.url.split('/').at(-1) ?? '' })}</>
  return <div ref={row} className="relative flex min-w-0 items-center gap-1.5 overflow-hidden">
    {pullRequests.slice(0, visible).map(pr => <Badge key={pr.url} variant="secondary" className={cn(OUTPUT_CHIP, 'pointer-events-auto relative', PULL_REQUEST_COLORS[pr.state])} render={<a href={pr.url} target="_blank" rel="noopener noreferrer" draggable={false} aria-label={t('pullRequest', { number: pr.url.split('/').at(-1) ?? '' })} title={stateLabel(pr.state)} data-pr-state={pr.state} />}>{contents(pr)}</Badge>)}
    {hidden > 0 && <Badge variant="secondary" className={cn(OUTPUT_CHIP, 'text-muted-foreground')} title={t('moreOutputsAria', { count: hidden })}>{t('moreOutputs', { count: hidden })}</Badge>}
    <div ref={measuring} aria-hidden="true" className="pointer-events-none invisible absolute flex gap-1.5 whitespace-nowrap">
      {pullRequests.slice(0, 2).map(pr => <Badge key={pr.url} variant="secondary" className={OUTPUT_CHIP}>{contents(pr)}</Badge>)}
      <Badge variant="secondary" className={OUTPUT_CHIP}>{t('moreOutputs', { count: pullRequests.length })}</Badge>
    </div>
  </div>
}

/** A thread as a card (R-66 frame 356:4750), shared by the chat and the thread list: the whole card opens it. */
export const THREAD_CARD = 'relative flex w-full items-center gap-3 rounded-xl bg-muted/60 px-3.5 py-3'
/** The card's full-size button; content above it does not take clicks. */
export const THREAD_CARD_BUTTON = 'absolute inset-0 size-full rounded-xl'

/** R-66 review frame 356:4750: status, title and outputs; one card per thread. A thread with no task opens too. */
export function ThreadCard({ run, onOpen }: { run: RunSource; onOpen: (thread: { issueId: string | null; runId: string }) => void }) {
  const t = useTranslations('IssueThreads')
  return <div data-slot="thread-card" className={cn(THREAD_CARD, 'max-w-md')}>
    <Button variant="ghost" className={THREAD_CARD_BUTTON} aria-label={t('open', { name: run.name })} onClick={() => onOpen({ issueId: run.issue?.id ?? null, runId: run.id })} />
    <ThreadStatusIcon status={run.status} outcome={run.outcome} />
    <div className="pointer-events-none relative flex min-w-0 flex-1 flex-col gap-2">
      <span className="truncate text-sm leading-5 font-medium">{run.name}</span>
      {Boolean(run.pullRequests?.length) && <ThreadOutputs pullRequests={run.pullRequests!} />}
      {run.info && <RunInfoLine info={run.info} />}
    </div>
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
