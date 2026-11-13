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
