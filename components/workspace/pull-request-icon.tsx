import type { IssuePullRequest } from '@/lib/issue-metadata'
import { PULL_REQUEST_COLORS, PULL_REQUEST_ICONS } from '@/lib/pull-request-appearance'

/** GitHub's four PR states, shared by task properties, board and thread outputs. */
export function PullRequestIcon({ state }: { state: IssuePullRequest['state'] }) {
  const Icon = PULL_REQUEST_ICONS[state]
  return <Icon aria-hidden="true" className={PULL_REQUEST_COLORS[state]} />
}
