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
