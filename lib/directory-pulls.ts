import { githubPullRequestKey, type IssuePullRequest } from './issue-metadata'

export const directoryPullStates = ['all', 'open', 'draft', 'merged', 'closed'] as const

/** A group shows an open PR first, then draft, then merged. */
export function pullRequestsState(pulls: readonly { state: IssuePullRequest['state'] }[]) {
  return (['open', 'draft', 'merged', 'closed'] as const).find(state => pulls.some(pr => pr.state === state)) ?? 'closed'
}

/** A GitHub PR can be delivered in several authorized conversations. */
export function directoryPullRequests<T extends { pulls: readonly IssuePullRequest[] }>(rows: readonly T[], state: IssuePullRequest['state'] | 'all') {
  const byUrl = new Map<string, { pull: IssuePullRequest; conversations: T[] }>()
  for (const row of rows) {
    for (const pull of row.pulls) {
      if (state !== 'all' && pull.state !== state) continue
      const key = githubPullRequestKey(pull.url)
      const existing = byUrl.get(key)
      if (!existing) byUrl.set(key, { pull, conversations: [row] })
      else if (existing.conversations.at(-1) !== row) existing.conversations.push(row)
    }
  }
  return [...byUrl.values()]
}
