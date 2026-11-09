'use client'

import useSWR, { unstable_serialize } from 'swr'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from 'lucide-react'
import { authClient } from '@/lib/auth-client'
import { withBasePath } from '@/lib/base-path'
import type { IssuePullRequest } from '@/lib/issue-metadata'
import { cn } from '@/lib/utils'
import { useLiveKey } from '@/hooks/use-live-key'
import { LIVE_ID } from '@/lib/live/events'
import { Badge } from '@/components/ui/badge'
import { Badge as BoardBadge } from '@/components/reui/badge'

type Status = { state: IssuePullRequest['state']; checkedAt: number; liveWorkspaceId: string | null } | { error: string }

/**
 * GitHub's answer for a PR with no webhook of ours (one linked by hand, or in a repository without the app)
 * is re-read at most this often, while the page is visible. A PR a run delivered also re-reads when the
 * webhook commits its state (`pull_request_status`, #1212).
 */
const UNHOOKED_RECHECK_MS = 5 * 60_000

async function fetchStatus([, userId, issueId, url]: readonly string[]): Promise<Status> {
  try {
    const response = await fetch(withBasePath('/api/github/pull-request-status'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueId, url }), cache: 'no-store',
    })
    const result = await response.json()
    if (response.ok && result.viewerId !== userId) return { error: 'authRequired' }
    if (response.ok && ['open', 'closed', 'merged'].includes(result.state)) return { state: result.state, checkedAt: performance.now(), liveWorkspaceId: typeof result.live?.workspaceId === 'string' && LIVE_ID.test(result.live.workspaceId) ? result.live.workspaceId : null }
    return { error: typeof result.error === 'string' ? result.error : 'githubUnavailable' }
  } catch { return { error: 'githubUnavailable' } }
}

const PR_ICONS = { open: GitPullRequest, draft: GitPullRequestDraft, merged: GitMerge, closed: GitPullRequestClosed } as const satisfies Record<IssuePullRequest['state'], unknown>

type LinkProps = { issueId: string; pr: IssuePullRequest; compact?: boolean }

export function IssuePullRequestLink(props: LinkProps) {
  const { data: session, isPending } = authClient.useSession()
  const userId = !isPending ? session?.user.id : undefined
  return <ViewerPullRequestLink key={JSON.stringify([userId, props.issueId, props.pr.url])} {...props} userId={userId} isPending={isPending} />
}

function ViewerPullRequestLink({ issueId, pr, compact = false, userId, isPending }: LinkProps & { userId: string | undefined; isPending: boolean }) {
  const tState = useTranslations('Metadata.prState')
  const tSync = useTranslations('Metadata.prSync')
  const [mountedAt] = useState(() => performance.now())
  const key = userId ? ['github-pr-status', userId, issueId, pr.url] as const : null
  const { data, isValidating } = useSWR(key, fetchStatus, {
    // A GitHub status check: on mount, on the task's live key, and on the slow recheck below; never on focus.
    refreshInterval: compact ? 0 : UNHOOKED_RECHECK_MS, refreshWhenHidden: false, revalidateOnFocus: false, revalidateOnMount: true, dedupingInterval: 0,
  })
  // Only the task's own channel, once a read has named it: an unknown channel would read on the 60 s fallback.
  const liveWorkspaceId = !compact && data && 'state' in data ? data.liveWorkspaceId : null
  useLiveKey('pull_request_status', liveWorkspaceId && key ? issueId : null, key ? [unstable_serialize(key)] : [], liveWorkspaceId, { minIntervalMs: 2_000 })
  // A refresh rechecks permission; the previous response is not proof of current access.
  const state = userId && !isValidating && data && 'state' in data && data.checkedAt >= mountedAt ? data.state : undefined
  const error = data && 'error' in data ? data.error : undefined
  const loading = !state && (isPending || isValidating || (userId && (!data || ('state' in data && data.checkedAt < mountedAt))))
  // No GitHub connection here (none set up, or not this person's): the link stays, with no status words beside it.
  const disconnected = !state && !loading && (!userId || error === 'githubNotConnected' || error === 'githubReconnectRequired' || error === 'githubNotConfigured')
  const statusLabel = state ? tSync('synced', { state: tState(state) }) : loading ? tSync('loading') : disconnected ? tSync('disconnected') : tSync('unavailable')
  const title = `${statusLabel} · ${tSync('manual', { state: tState(pr.state) })} · ${pr.url}`
  // The icon's shape is the PR state (Figma icon/14/pr-*): GitHub's when it answered, else the state saved on the task.
  // Only a state GitHub just confirmed for this viewer gets its colour; a saved or stale one stays grey.
  const Icon = PR_ICONS[state ?? pr.state]
  const content = <><Icon data-icon="inline-start" className={cn(!state && 'text-muted-foreground', state === 'open' && 'text-success-foreground', state === 'merged' && 'text-info-foreground', state === 'closed' && 'text-destructive-foreground')} />#{pr.url.split('/').filter(Boolean).at(-1)}{!compact && !disconnected && <span className="text-muted-foreground">{state ? tState(state) : statusLabel}</span>}</>
  const link = <a href={pr.url} draggable={false} target="_blank" rel="noopener noreferrer" title={title} aria-label={title} />
  return compact
    ? <BoardBadge variant="outline" size="lg" className="h-5 gap-1 border-transparent px-0 text-xs font-normal text-muted-foreground tabular-nums [&_svg]:size-3.5" render={link}>{content}</BoardBadge>
    : <Badge tone={state === 'merged' ? 'focus' : state === 'closed' ? 'destructive' : state === 'open' ? 'success' : undefined} variant="outline" className="h-6" render={link}>{content}</Badge>
}
