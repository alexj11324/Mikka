import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from 'lucide-react'

export const PULL_REQUEST_COLORS = {
  open: 'text-github-pr-open',
  draft: 'text-github-pr-draft',
  merged: 'text-github-pr-merged',
  closed: 'text-github-pr-closed',
} as const

/** The word beside a row's mark: GitHub's own states keep the Primer colours above, a derived check
 *  state takes the same status colour the rest of the product uses for that verdict (R-87). */
export const PULL_STATE_TONES = {
  ready: 'text-success-foreground',
  pending: 'text-warning-foreground',
  failed: 'text-destructive-foreground',
  draft: 'text-github-pr-draft',
  open: 'text-github-pr-open',
  merged: 'text-github-pr-merged',
  closed: 'text-github-pr-closed',
} as const

export const PULL_REQUEST_ICONS = {
  open: GitPullRequest,
  draft: GitPullRequestDraft,
  merged: GitMerge,
  closed: GitPullRequestClosed,
} as const

export { directoryPullRequests, pullRequestsState } from './directory-pulls'
