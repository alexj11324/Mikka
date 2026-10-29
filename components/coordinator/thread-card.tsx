'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronRight } from 'lucide-react'
import type { RunSource } from '@/lib/coordinator/citations'
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

/** R-66 review frame 356:4750: status, title and outputs; one card per thread. */
export function ThreadCard({ run, onOpen }: { run: RunSource; onOpen: (thread: { issueId: string; runId: string }) => void }) {
  const t = useTranslations('IssueThreads')
  const issue = run.issue
  return <div data-slot="thread-card" className="relative flex w-full max-w-md items-center gap-3 rounded-xl bg-muted px-3.5 py-3">
    <Button variant="ghost" className="absolute inset-0 size-full rounded-xl" aria-label={t('open', { name: run.name })} disabled={!issue} onClick={issue ? () => onOpen({ issueId: issue.id, runId: run.id }) : undefined} />
    <ThreadStatusIcon status={run.status} />
    <div className="pointer-events-none relative flex min-w-0 flex-1 flex-col gap-2">
      <span className="truncate text-sm leading-5 font-medium">{run.name}</span>
      {Boolean(run.pullRequests?.length) && <ThreadOutputs pullRequests={run.pullRequests!} />}
    </div>
    <ChevronRight aria-hidden="true" className="pointer-events-none relative size-4 shrink-0 text-muted-foreground" />
  </div>
}
