'use client'

import { ChevronRight, Hash, Laptop, Server } from 'lucide-react'
import { useFormatter, useNow, useTranslations } from 'next-intl'
import type { listIssues } from '@/app/actions/issues'
import type { Thread } from '@/app/actions/task-runs'
import type { BotView } from '@/app/actions/bots'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { issueIdentifier } from '@/components/workspace/issue-properties'
import { activityLabel, groupThreads, lastActivity, THREAD_GROUPS } from '@/lib/thread-groups'
import { cn } from '@/lib/utils'
import { HarnessMark } from '@/components/labels/entity-labels'
import { BotAvatar, CoordinatorAvatar } from './bot-avatar'
import { GroupHeader } from './group-header'

type Issue = Awaited<ReturnType<typeof listIssues>>[number]

/**
 * A thread's own name, about its work (docs/design/glossary.md): its task,
 * as "#71 Infisical 连接超时排查", else the first line of what it was asked.
 * Never the bot's name.
 */
/** Two-line row (name, then a muted line) shared by the thread and PR lists in the right panel. */
export const TWO_LINE_ROW = 'flex h-auto w-full flex-col items-stretch justify-start gap-0.5 rounded-lg px-2 py-1.5 text-left font-normal whitespace-normal'

export function threadName(thread: Thread, issues: Issue[], fallback: string) {
  const issue = thread.issueId ? issues.find(item => item.id === thread.issueId) : undefined
  if (issue) return `${issueIdentifier(issue)} ${issue.title}`
  return thread.prompt.split('\n').find(line => line.trim())?.trim().slice(0, 80) || fallback
}

/** A thread's mark: an orange disc with # (Figma 188:3192), 72px on its 详情. */
export function ThreadMark({ size = 'profile' }: { size?: 'profile' | 'row' }) {
  return <span aria-hidden="true" className={cn('flex shrink-0 items-center justify-center rounded-full bg-avatar-5 text-avatar-foreground', size === 'profile' && 'size-18', size === 'row' && 'size-4')}>
    <Hash className={cn(size === 'profile' && 'size-8', size === 'row' && 'size-2.5')} strokeWidth={2.5} />
  </span>
}

/** The device a queued run waits for while it is offline (#545). Until #545 ships, `listThreads` leaves it out. */
type ThreadView = Thread & { waitingFor?: { deviceId: string; deviceName: string; deviceType: 'laptop' | 'server'; harness: string } }

/** 等待 <device> 上线 (Figma WS-38): the device type, its offline dot, then the agent's mark (R-74). */
function WaitingChip({ waiting }: { waiting: NonNullable<ThreadView['waitingFor']> }) {
  const t = useTranslations('Shell.threads')
  const Icon = waiting.deviceType === 'server' ? Server : Laptop
  return <span className="inline-flex max-w-full min-w-0 items-center gap-1.5 self-start rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
    <Icon aria-hidden="true" className="size-3.5 shrink-0" />
    <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
    <span className="truncate">{t('waitingFor', { device: waiting.deviceName })}</span>
    <HarnessMark harness={waiting.harness} />
  </span>
}

/**
 * One row: the thread's name, then the opening of its last reply on one line,
 * verbatim. No status word, no bot name. In 全部线程 a 16px avatar in its
 * bot's colour leads the name and the last activity sits on the right.
 */
function ThreadRow({ thread, issues, bots, all, now, onOpenIssue }: { thread: Thread; issues: Issue[]; bots: BotView[]; all: boolean; now: Date; onOpenIssue: (id: string) => void }) {
  const t = useTranslations('Shell.threads')
  const format = useFormatter()
  const bot = thread.botId ? bots.find(item => item.id === thread.botId) : undefined
  const name = threadName(thread, issues, t('untitled'))
  const at = new Date(lastActivity(thread))
  const when = activityLabel(at, now)
  const waiting = thread.status === 'queued' ? (thread as ThreadView).waitingFor : undefined
  const body = <>
    <span className="flex w-full min-w-0 items-center gap-2">
      {all && (thread.botId ? <BotAvatar color={bot?.color} shape={bot?.shape} size="row" /> : <CoordinatorAvatar size="row" />)}
      <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
      {all && <span className="shrink-0 text-xs text-muted-foreground">{when === 'relative' ? format.relativeTime(at, now) : t(when)}</span>}
    </span>
    {waiting
      ? <span className={cn('flex w-full min-w-0', all && 'pl-6')}><WaitingChip waiting={waiting} /></span>
      : thread.lastReply && <span className={cn('block w-full truncate text-xs text-muted-foreground', all && 'pl-6')}>{thread.lastReply}</span>}
  </>
  return <li>
    {thread.issueId
      ? <Button variant="ghost" className={TWO_LINE_ROW} aria-label={name} onClick={() => onOpenIssue(thread.issueId!)}>{body}</Button>
      : <div className={TWO_LINE_ROW}>{body}</div>}
  </li>
}

/**
 * The right column's thread list: 等待回复 → 进行中 → 空闲 → 已解决, each
 * with its count; 已解决 starts collapsed. A failed thread waits for the
 * person, so it sits under 等待回复. Picking a thread opens its task.
 */
export function ThreadList({ threads, issues, bots, all = false, onOpenIssue }: { threads: Thread[]; issues: Issue[]; bots: BotView[]; all?: boolean; onOpenIssue: (id: string) => void }) {
  const t = useTranslations('Shell.threads')
  // One clock for every row's time.
  const now = useNow({ updateInterval: 60_000 })
  if (!threads.length) return <p className="px-2 py-6 text-center text-xs text-muted-foreground">{t('empty')}</p>
  const groups = groupThreads(threads, id => issues.find(issue => issue.id === id))
  const rows = (list: Thread[]) => <ul className="flex flex-col">{list.map(thread => <ThreadRow key={thread.id} thread={thread} issues={issues} bots={bots} all={all} now={now} onOpenIssue={onOpenIssue} />)}</ul>
  return <div role="group" aria-label={t('title')} className="flex flex-col gap-3">
    {THREAD_GROUPS.map(group => {
      const list = groups[group]
      if (!list.length) return null
      const label = t(`group.${group}`, { count: list.length })
      if (group === 'resolved') return <Collapsible key={group} className="flex flex-col gap-1">
        <CollapsibleTrigger render={<Button variant="ghost" className="group flex h-auto w-full p-0 text-left font-normal hover:bg-transparent" />}>
          <GroupHeader>{label}<ChevronRight aria-hidden="true" className="size-3.5 transition-transform group-data-panel-open:rotate-90" /></GroupHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>{rows(list)}</CollapsibleContent>
      </Collapsible>
      return <section key={group} aria-label={label} className="flex flex-col gap-1"><GroupHeader>{label}</GroupHeader>{rows(list)}</section>
    })}
  </div>
}
