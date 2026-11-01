'use client'

import useSWR from 'swr'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from 'lucide-react'
import { authClient } from '@/lib/auth-client'
import { withBasePath } from '@/lib/base-path'
import type { IssuePullRequest } from '@/lib/issue-metadata'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { Badge as BoardBadge } from '@/components/reui/badge'

type Status = { state: IssuePullRequest['state']; checkedAt: number } | { error: string }

async function fetchStatus([, userId, issueId, url]: readonly string[]): Promise<Status> {
  try {
    const response = await fetch(withBasePath('/api/github/pull-request-status'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ issueId, url }), cache: 'no-store',
    })
    const result = await response.json()
    if (response.ok && result.viewerId !== userId) return { error: 'authRequired' }
    if (response.ok && ['open', 'closed', 'merged'].includes(result.state)) return { state: result.state, checkedAt: performance.now() }
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
  const { data, isValidating } = useSWR(userId ? ['github-pr-status', userId, issueId, pr.url] : null, fetchStatus, {
    refreshInterval: compact ? 0 : 60_000, revalidateOnFocus: true, revalidateOnMount: true, dedupingInterval: 0,
  })
  // A refresh rechecks permission; the previous response is not proof of current access.
  const state = userId && !isValidating && data && 'state' in data && data.checkedAt >= mountedAt ? data.state : undefined
  const error = data && 'error' in data ? data.error : undefined
  const statusLabel = state ? tSync('synced', { state: tState(state) })
    : isPending || isValidating || (userId && (!data || ('state' in data && data.checkedAt < mountedAt))) ? tSync('loading')
      : !userId || error === 'githubNotConnected' || error === 'githubReconnectRequired' ? tSync('disconnected') : tSync('unavailable')
  const title = `${statusLabel} · ${tSync('manual', { state: tState(pr.state) })} · ${pr.url}`
  // The icon carries the PR state (Figma icon/14/pr-*): GitHub's when it answered, else the state saved on the task.
  const shown = state ?? pr.state
  const Icon = PR_ICONS[shown]
  const content = <><Icon data-icon="inline-start" className={cn(shown === 'open' && 'text-success-foreground', shown === 'draft' && 'text-muted-foreground', shown === 'merged' && 'text-info-foreground', shown === 'closed' && 'text-destructive')} />#{pr.url.split('/').filter(Boolean).at(-1)}{!compact && <span className="text-muted-foreground">{state ? tState(state) : statusLabel}</span>}</>
  const link = <a href={pr.url} draggable={false} target="_blank" rel="noopener noreferrer" title={title} aria-label={title} />
  return compact
    ? <BoardBadge variant="outline" size="lg" className="h-5 gap-1 border-transparent px-0 text-xs font-normal text-muted-foreground tabular-nums [&_svg]:size-3.5" render={link}>{content}</BoardBadge>
    : <Badge tone={state === 'merged' ? 'focus' : state === 'closed' ? 'destructive' : state === 'open' ? 'success' : undefined} variant="outline" className="h-6" render={link}>{content}</Badge>
}
