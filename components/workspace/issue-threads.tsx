'use client'

import useSWR from 'swr'
import { useFormatter, useNow, useTranslations } from 'next-intl'
import { ChevronRight } from 'lucide-react'
import { listIssueThreads } from '@/app/actions/agents'
import type { IssueThread } from '@/lib/issue-threads'
import { runListRefreshInterval, runStatusKey } from '@/lib/issue-run-conversation'
import { LetterAvatar } from '@/components/nav/letter-avatar'
import { Badge } from '@/components/reui/badge'
import { Button } from '@/components/ui/button'
import { RUN_BADGES } from './agent-citations'
import { cn } from '@/lib/utils'

export function useIssueThreads(issueId: string) {
  return useSWR(['issue-threads', issueId], () => listIssueThreads(issueId), { refreshInterval: runListRefreshInterval, revalidateOnFocus: true, revalidateOnReconnect: true })
}

export function harnessLabel(harness: string) {
  return harness === 'claude_code' ? 'Claude Code' : harness === 'codex' ? 'Codex' : harness
}

export function ThreadStatus({ status }: { status: string }) {
  const statusLabel = useTranslations('Coordinator.citation.runStatus')
  const key = runStatusKey(status)
  return <Badge variant={RUN_BADGES[status] ?? 'secondary'} size="sm">{key ? statusLabel(key) : status}</Badge>
}

/** 线程: the agent runs working on this issue (R-62). A readable one opens on the right. */
export function IssueThreads({ issueId, openId, onOpen }: { issueId: string; openId: string | null; onOpen: (id: string) => void }) {
  const t = useTranslations('IssueThreads')
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const { data, error, mutate } = useIssueThreads(issueId)
  if (error) return <div role="alert" className="flex items-center gap-2 text-xs"><span className="text-destructive">{t('loadFailed')}</span><Button variant="ghost" size="xs" onClick={() => { void mutate() }}>{t('retry')}</Button></div>
  if (!data?.length) return null
  return <section aria-labelledby={`threads-${issueId}`} className="flex flex-col gap-2">
    <h2 id={`threads-${issueId}`} className="flex items-baseline gap-1.5 text-sm font-medium">{t('title')}<span className="text-xs font-normal text-muted-foreground tabular-nums">{data.length}</span></h2>
    <ul className="flex flex-col rounded-xl bg-muted/50 p-1">
      {data.map(thread => {
        const name = thread.detail?.name ?? (thread.ownerName ? t('ownerThread', { name: thread.ownerName }) : t('hidden'))
        // The bot runs the thread; the coding agent it hands work to is a step inside it, not the runner (R-05).
        const meta = thread.detail?.summary ?? null
        const body = <>
          <LetterAvatar name={thread.detail?.agentName ?? t('agent')} size="pill" />
          <span className="flex min-w-0 flex-1 flex-col text-left">
            <span className="truncate text-sm font-medium">{name}</span>
            {meta && <span className="truncate text-xs font-normal text-muted-foreground">{meta}</span>}
          </span>
          <ThreadStatus status={thread.status} />
          <time className="w-14 shrink-0 text-right text-xs font-normal text-muted-foreground" dateTime={new Date(thread.finishedAt ?? thread.createdAt).toISOString()}>{format.relativeTime(new Date(thread.finishedAt ?? thread.createdAt), now)}</time>
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
      <LetterAvatar name={thread.detail?.agentName ?? t('agent')} size="pill" />
      <span className="font-medium">{thread.detail?.agentName ?? t('agent')}</span>
      <span className="text-muted-foreground">{t('dispatched')}</span>
      {thread.detail
        ? <Button variant="secondary" size="xs" className="max-w-60 rounded-md" aria-label={t('open', { name })} onClick={() => onOpen(thread.id)}><span className="truncate">{name}</span></Button>
        : <span className="truncate text-muted-foreground">{name}</span>}
      <time className="text-xs text-muted-foreground" dateTime={new Date(thread.createdAt).toISOString()}>{format.dateTime(new Date(thread.createdAt), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
    </div>
  })}</>
}
