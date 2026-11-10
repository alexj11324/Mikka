'use client'

import type { ReactNode } from 'react'
import useSWR, { unstable_serialize } from 'swr'
import { useFormatter, useNow, useTranslations } from 'next-intl'
import { ChevronRight } from 'lucide-react'
import { pollIssueThreads } from '@/app/actions/agents'
import { acceptedProducerOutcome, agentStretches, threadQuestionView, threadTime, type IssueThread } from '@/lib/issue-threads'
import { useLiveKey } from '@/hooks/use-live-key'
import { UNRESOLVED_LIST_SCOPE } from '@/lib/live/list-read'
import { BotAvatar, COORDINATOR_AVATAR, colorFor } from '@/components/nav/bot-avatar'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/reui/badge'
import { runResult, useRunResultLabel, type RunResult } from '@/hooks/use-run-result'
import { GROUP_BADGES, ThreadStatusIcon } from './thread-status-icon'
import { HarnessMark, harnessName } from '@/components/labels/entity-labels'
import type { ThreadGroup } from '@/lib/thread-groups'
import { cn } from '@/lib/utils'
import { InlineLoadError } from '@/components/load-error'
import { useAcceptanceTasks } from './factory-acceptance'

/** The SWR key of an issue's thread list; it holds `{ threads, live }`. */
export const issueThreadsKey = (issueId: string) => ['issue-threads', issueId] as const
export type IssueThreadsRead = Awaited<ReturnType<typeof pollIssueThreads>>

/** No timer reads the list (#1212): a run change on this issue, a teammate's included, pushes
 * `issue_threads` to every member who can see it. While the channel is down it is read once a minute. */
export function useIssueThreads(issueId: string, enabled = true) {
  const key = issueThreadsKey(issueId)
  const result = useSWR(enabled ? key : null, () => pollIssueThreads(issueId), { revalidateOnReconnect: true })
  const scope = enabled ? result.data?.live.workspaceId ?? null : null
  useLiveKey('issue_threads', scope ? issueId : UNRESOLVED_LIST_SCOPE, [unstable_serialize(key)], scope, { minIntervalMs: 2_000 })
  return { ...result, data: result.data?.threads }
}

export function harnessLabel(harness: string) {
  return harness === 'claude_code' ? 'Claude Code' : harness === 'codex' ? 'Codex' : harness
}

/** A run result's dot and badge colour: its R-52 group's (失败 and 受阻 read red, 完成 green, 等你回复 amber). */
const RESULT_GROUP: Record<RunResult, ThreadGroup> = { running: 'running', queued: 'running', waiting: 'waiting', done: 'resolved', failed: 'blocked', blocked: 'blocked', idle: 'idle', ended: 'idle' }

/** One 活动 row (R-62). `at` places it among the task's own events. */
export type AgentActivityRow = { id: string; at: string; node: ReactNode }

/**
 * 活动's Agent rows (R-62, decision 2026-11-09-0045): one row per Agent stretch, oldest first, never one per
 * run. Every row is labelled by its Agent, its mark and name as the Agents list shows them (R-74, R-78), never a
 * 「换」 verb: as Warp does, a change of Agent is read from the next row's name. A row shows the stretch's latest
 * run result and opens the task's one conversation at the stretch's first thread.
 */
/** An Agent row as data, for a layer that draws the log: its mark (the Agent's, or the result's), name, run result and time. */
export type AgentActivityItem = { id: string; at: string; name: string; mark: ReactNode; result: string; group: ThreadGroup; time: string; open: boolean; onOpen: (() => void) | null }

export function useAgentActivity(issueId: string, openId: string | null, onOpen: (id: string) => void, enabled = true): { rows: AgentActivityRow[]; items: AgentActivityItem[]; error: ReactNode; failed: { label: string; retry: () => void } | null } {
  const t = useTranslations('IssueThreads')
  const resultLabel = useRunResultLabel()
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const { data, error, mutate } = useIssueThreads(issueId, enabled)
  const { allTasks } = useAcceptanceTasks(enabled ? issueId : null)
  if (!enabled) return { rows: [], items: [], error: null, failed: null }
  if (error) return { rows: [], items: [], error: <InlineLoadError message={t('loadFailed')} retryLabel={t('retry')} onRetry={() => { void mutate() }} />, failed: { label: t('loadFailed'), retry: () => { void mutate() } } }
  const stretches = agentStretches(data ?? [])
  const items: AgentActivityItem[] = []
  const rows = stretches.map(({ first, last, ids }, index): AgentActivityRow => {
    const harness = last.detail?.harness ?? null
    const name = harness ? harnessName(harness) : (last.ownerName ? t('ownerThread', { name: last.ownerName }) : t('hidden'))
    const view = threadQuestionView(last)
    const outcome = acceptedProducerOutcome(last, issueId, allTasks)
    // The stretch's latest run, in the run-result words the right column and iOS use (glossary: Run result).
    const { result, reason } = runResult({ status: view.waiting ? 'waiting_input' : view.status, outcome }, index === stretches.length - 1)
    const group = RESULT_GROUP[result]
    const open = openId !== null && ids.includes(openId)
    const body = <>
      {harness ? <span data-slot="agent-mark" className="flex size-5 shrink-0 items-center justify-center [&_svg]:size-4.5"><HarnessMark harness={harness} /></span> : <ThreadStatusIcon group={group} />}
      <span className="min-w-0 flex-1 truncate text-left text-sm font-medium">{name}</span>
      <Badge variant={view.stopping ? 'secondary' : GROUP_BADGES[group]} size="sm" data-group={group} data-run-result={result}>{view.stopping ? t('stopping') : resultLabel(result, reason)}</Badge>
      <time className="min-w-14 shrink-0 whitespace-nowrap text-right text-xs font-normal text-muted-foreground tabular-nums" dateTime={new Date(last.finishedAt ?? last.createdAt).toISOString()}>{format.relativeTime(threadTime(last, now), now)}</time>
    </>
    const node = first.detail
      ? <Button variant="ghost" data-agent-stretch={index + 1} aria-pressed={open} aria-label={t('open', { name })} className={cn('-mx-3 h-auto w-[calc(100%+1.5rem)] justify-start gap-3 rounded-lg px-3 py-2', open && 'bg-muted hover:bg-muted')} onClick={() => onOpen(first.id)}>{body}<ChevronRight data-icon="inline-end" className="text-muted-foreground rtl:rotate-180" /></Button>
      : <div className="flex min-w-0 items-center gap-3 py-2">{body}<span className="size-4" /></div>
    const at = new Date(first.createdAt).toISOString()
    items.push({ id: `agent:${first.id}`, at, name, mark: harness ? <HarnessMark harness={harness} /> : <ThreadStatusIcon group={group} />, result: view.stopping ? t('stopping') : resultLabel(result, reason), group, time: format.relativeTime(threadTime(last, now), now), open, onOpen: first.detail ? () => onOpen(first.id) : null })
    return { id: `agent:${first.id}`, at, node }
  })
  return { rows, items, error: null, failed: null }
}

/** The dispatching Bot in its own look (R-36): the same bloub as its bot-list row; the Coordinator's own runs use its mark. */
export function ThreadBotAvatar({ thread, size = 'pill' }: { thread: Pick<IssueThread, 'detail'>; size?: 'pill' | 'row' }) {
  const t = useTranslations('IssueThreads')
  if (!thread.detail) return <BotAvatar color={colorFor(t('agent'))} size={size} still />
  return <BotAvatar {...(thread.detail.bot ?? COORDINATOR_AVATAR)} size={size} still />
}
