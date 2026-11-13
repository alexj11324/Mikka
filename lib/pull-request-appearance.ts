import type { IssuePullRequest } from './issue-metadata'
import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from 'lucide-react'

export const PULL_REQUEST_COLORS = {
  open: 'text-github-pr-open',
  draft: 'text-github-pr-draft',
  merged: 'text-github-pr-merged',
  closed: 'text-github-pr-closed',
} as const

export const PULL_REQUEST_ICONS = {
  open: GitPullRequest,
  draft: GitPullRequestDraft,
  merged: GitMerge,
  closed: GitPullRequestClosed,
} as const

/** A group shows an open PR first, then draft, then merged. */
export function pullRequestsState(pulls: readonly { state: keyof typeof PULL_REQUEST_COLORS }[]) {
  return (['open', 'draft', 'merged', 'closed'] as const).find(state => pulls.some(pr => pr.state === state)) ?? 'closed'
}

/** A GitHub PR can be delivered in several authorized conversations. */
export function directoryPullRequests<T extends { pulls: readonly IssuePullRequest[] }>(rows: T[], state: IssuePullRequest['state'] | 'all') {
  const byUrl = new Map<string, { pull: IssuePullRequest; conversations: T[] }>()
  for (const row of rows) {
    for (const pull of row.pulls) {
      if (state !== 'all' && pull.state !== state) continue
      const key = pull.url.toLowerCase().replace(/\/$/, '')
      const existing = byUrl.get(key)
      if (!existing) byUrl.set(key, { pull, conversations: [row] })
      else if (existing.conversations.at(-1) !== row) existing.conversations.push(row)
    }
  }
  return [...byUrl.values()]
}
