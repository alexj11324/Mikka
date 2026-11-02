'use client'

import useSWR from 'swr'
import { useFormatter, useNow, useTranslations } from 'next-intl'
import { ChevronRight, Hand } from 'lucide-react'
import { listIssueThreads } from '@/app/actions/agents'
import { threadQuestionView, threadTime, type IssueThread } from '@/lib/issue-threads'
import { runListRefreshInterval, runStatusKey } from '@/lib/issue-run-conversation'
import { BotAvatar, COORDINATOR_AVATAR, colorFor } from '@/components/nav/bot-avatar'
import { Badge } from '@/components/reui/badge'
import { Button } from '@/components/ui/button'
import { RUN_BADGES } from './agent-citations'
import { ThreadStatusIcon } from './thread-status-icon'
import { cn } from '@/lib/utils'
import { InlineLoadError } from '@/components/load-error'

export function useIssueThreads(issueId: string) {
  return useSWR(['issue-threads', issueId], () => listIssueThreads(issueId), { refreshInterval: threads => runListRefreshInterval(threads?.map(threadQuestionView)), revalidateOnReconnect: true })
}

export function harnessLabel(harness: string) {
  return harness === 'claude_code' ? 'Claude Code' : harness === 'codex' ? 'Codex' : harness
}

export function ThreadStatus({ status, stopping = false, waiting = false }: { status: string; stopping?: boolean; waiting?: boolean }) {
  const statusLabel = useTranslations('Coordinator.citation.runStatus')
  const t = useTranslations('IssueThreads')
  const key = runStatusKey(status)
  if (waiting) return <Badge variant="warning-light" size="sm"><Hand aria-hidden="true" />{t('waiting')}</Badge>
  if (stopping) return <Badge variant="secondary" size="sm">{t('stopping')}</Badge>
  // A run waiting on input is 等待你 (R-52): it raises the same hand.
  return <Badge variant={RUN_BADGES[status] ?? 'secondary'} size="sm">{status === 'waiting_input' && <Hand aria-hidden="true" />}{key ? statusLabel(key) : status}</Badge>
}

/** 线程: the agent runs working on this issue (R-62). A readable one opens on the right. */
export function IssueThreads({ issueId, openId, onOpen }: { issueId: string; openId: string | null; onOpen: (id: string) => void }) {
  const t = useTranslations('IssueThreads')
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const { data, error, mutate } = useIssueThreads(issueId)
  if (error) return <InlineLoadError message={t('loadFailed')} retryLabel={t('retry')} onRetry={() => { void mutate() }} />
  if (!data?.length) return null
  return <section aria-labelledby={`threads-${issueId}`} className="flex flex-col gap-2">
    <h2 id={`threads-${issueId}`} className="flex items-baseline gap-1.5 text-sm font-medium">{t('title')}<span className="text-xs font-normal text-muted-foreground tabular-nums">{data.length}</span></h2>
    <ul className="flex flex-col rounded-xl bg-muted/50 p-1">
      {data.map(thread => {
        const name = thread.detail?.name ?? (thread.ownerName ? t('ownerThread', { name: thread.ownerName }) : t('hidden'))
        // The bot runs the thread; the coding agent it hands work to is a step inside it, not the runner (R-05).
        const meta = thread.detail?.summary ?? null
        const view = threadQuestionView(thread)
        const body = <>
          <ThreadStatusIcon status={view.status} outcome={view.outcome} waiting={view.waiting} />
          <span className="flex min-w-0 flex-1 flex-col text-left">
            <span className="truncate text-sm font-medium">{name}</span>
            {meta && <span className="truncate text-xs font-normal text-muted-foreground">{meta}</span>}
          </span>
          <ThreadStatus status={view.status} stopping={view.stopping} waiting={view.waiting} />
          <time className="min-w-14 shrink-0 whitespace-nowrap text-right text-xs font-normal text-muted-foreground tabular-nums" dateTime={new Date(thread.finishedAt ?? thread.createdAt).toISOString()}>{format.relativeTime(threadTime(thread, now), now)}</time>
        </>
        return <li key={thread.id}>
          {thread.detail
            ? <Button variant="ghost" aria-pressed={openId === thread.id} aria-label={t('open', { name })} className={cn('h-auto w-full justify-start gap-3 rounded-lg px-3 py-2.5', openId === thread.id && 'bg-background shadow-xs hover:bg-background')} onClick={() => onOpen(thread.id)}>{body}<ChevronRight data-icon="inline-end" className="text-muted-foreground" /></Button>
            : <div className="flex items-center gap-3 px-3 py-2.5">{body}<span className="size-4" /></div>}
        </li>
      })}
    </ul>
  </section>
}

/** Activity rows: 「<Agent> 派出线程 [线程]」, oldest first. */
export function ThreadEvents({ issueId, onOpen }: { issueId: string; onOpen: (id: string) => void }) {
  const t = useTranslations('IssueThreads')
  const format = useFormatter()
  const { data } = useIssueThreads(issueId)
  if (!data?.length) return null
  return <>{[...data].reverse().map((thread: IssueThread) => {
    const name = thread.detail?.name ?? (thread.ownerName ? t('ownerThread', { name: thread.ownerName }) : t('hidden'))
    return <div key={thread.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <ThreadBotAvatar thread={thread} />
      <span className="font-medium">{thread.detail?.agentName ?? t('agent')}</span>
      <span className="text-muted-foreground">{t('dispatched')}</span>
      {thread.detail
        ? <Button variant="secondary" size="xs" className="max-w-60 rounded-md" aria-label={t('open', { name })} onClick={() => onOpen(thread.id)}><span className="truncate">{name}</span></Button>
        : <span className="truncate text-muted-foreground">{name}</span>}
      <time className="text-xs text-muted-foreground" dateTime={new Date(thread.createdAt).toISOString()}>{format.dateTime(new Date(thread.createdAt), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
    </div>
  })}</>
}

/** The dispatching Bot in its own look (R-36): the same bloub as its bot-list row; the Coordinator's own runs use its mark. */
export function ThreadBotAvatar({ thread, size = 'pill' }: { thread: Pick<IssueThread, 'detail'>; size?: 'pill' | 'row' }) {
  const t = useTranslations('IssueThreads')
  if (!thread.detail) return <BotAvatar color={colorFor(t('agent'))} size={size} still />
  return <BotAvatar {...(thread.detail.bot ?? COORDINATOR_AVATAR)} size={size} still />
}
