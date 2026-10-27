'use client'

import useSWR from 'swr'
import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { GitMerge, GitPullRequest, X } from 'lucide-react'
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
  const Icon = state === 'merged' ? GitMerge : state === 'closed' ? X : GitPullRequest
  const content = <><Icon data-icon="inline-start" className={cn(!state && 'text-muted-foreground', state === 'open' && 'text-success-foreground', state === 'merged' && 'text-info-foreground', state === 'closed' && 'text-destructive')} />#{pr.url.split('/').filter(Boolean).at(-1)}{!state && !compact && <span className="text-muted-foreground">{statusLabel}</span>}</>
  const link = <a href={pr.url} draggable={false} target="_blank" rel="noopener noreferrer" title={title} aria-label={title} />
  return compact
    ? <BoardBadge variant="outline" size="lg" className="border-transparent px-1 tabular-nums" render={link}>{content}</BoardBadge>
    : <Badge tone={state === 'merged' ? 'focus' : state === 'closed' ? 'destructive' : state === 'open' ? 'success' : undefined} variant="outline" className="h-6" render={link}>{content}</Badge>
}
