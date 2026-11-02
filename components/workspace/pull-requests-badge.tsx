'use client'

import { useTranslations } from 'next-intl'
import type { IssuePullRequest } from '@/lib/issue-metadata'
import { PULL_REQUEST_COLORS, PULL_REQUEST_ICONS } from '@/lib/pull-request-appearance'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

/** A PR as a thread card lists it; additions and deletions show only where a reader supplies them. */
export type BadgePullRequest = IssuePullRequest & { additions?: number; deletions?: number }

type State = IssuePullRequest['state']

/**
 * One state for a set of PRs, as Claude Code's session list shows it: any open
 * one is open, else any draft is a draft, else any merged one is merged, else
 * they were all closed without merging.
 */
export function pullRequestsState(pullRequests: readonly Pick<IssuePullRequest, 'state'>[]): State {
  for (const state of ['open', 'draft', 'merged'] as const) if (pullRequests.some(pr => pr.state === state)) return state
  return 'closed'
}

/** `Mikka #92` from `https://github.com/owner/Mikka/pull/92`. */
export function pullRequestRef(url: string) {
  const [, , , , repo, , number] = url.replace(/\/$/, '').split('/')
  return { repo: repo ?? '', number: number ?? '' }
}

/**
 * The PRs a thread produced, on its card: the state's git mark and the count.
 * Hovering (or tapping, on a phone) lists each PR: its title, then its state,
 * repository and number, and its added and removed lines when known. A row
 * opens the PR on GitHub. The badge sits above the card's own button, so a
 * click on it never opens the thread.
 */
export function PullRequestsBadge({ pullRequests }: { pullRequests: readonly BadgePullRequest[] }) {
  const t = useTranslations('PullRequestsBadge')
  const tState = useTranslations('Metadata.prState')
  if (!pullRequests.length) return null
  const state = pullRequestsState(pullRequests)
  const Icon = PULL_REQUEST_ICONS[state]
  return <Popover>
    <PopoverTrigger openOnHover delay={150} closeDelay={150}
      data-slot="pull-requests-badge" data-state-summary={state} aria-label={t('label', { count: pullRequests.length })}
      className={cn('pointer-events-auto relative inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs font-medium tabular-nums outline-none hover:bg-control focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-control', PULL_REQUEST_COLORS[state])}
      onClick={event => event.stopPropagation()}>
      <Icon aria-hidden="true" className="size-3.5" />
      {pullRequests.length}
    </PopoverTrigger>
    <PopoverContent align="end" className="w-80 gap-0 p-1" data-slot="pull-requests-list">
      <ul className="flex flex-col">
        {pullRequests.map(pr => {
          const RowIcon = PULL_REQUEST_ICONS[pr.state]
          const { repo, number } = pullRequestRef(pr.url)
          return <li key={pr.url}>
            <a href={pr.url} target="_blank" rel="noopener noreferrer" data-slot="pull-request-row"
              className="flex flex-col gap-1 rounded-md px-2.5 py-2 outline-none hover:bg-control focus-visible:bg-control">
              <span className="truncate text-sm font-medium text-foreground">{pr.title ?? `${repo} #${number}`}</span>
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <RowIcon aria-hidden="true" className={cn('size-3.5 shrink-0', PULL_REQUEST_COLORS[pr.state])} />
                <span className={cn('shrink-0 font-medium', PULL_REQUEST_COLORS[pr.state])}>{tState(pr.state)}</span>
                <span className="min-w-0 truncate">{repo} #{number}</span>
                {pr.additions !== undefined && pr.deletions !== undefined && <span className="ml-auto flex shrink-0 gap-1.5 tabular-nums">
                  <span className="text-github-pr-open">+{pr.additions}</span>
                  <span className="text-github-pr-closed">−{pr.deletions}</span>
                </span>}
              </span>
            </a>
          </li>
        })}
      </ul>
    </PopoverContent>
  </Popover>
}
