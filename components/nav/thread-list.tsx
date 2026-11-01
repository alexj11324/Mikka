'use client'

import { ChevronRight, Hash, Laptop, Server } from 'lucide-react'
import { useFormatter, useNow, useTranslations } from 'next-intl'
import type { listIssues } from '@/app/actions/issues'
import type { Thread } from '@/app/actions/task-runs'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { issueIdentifier } from '@/components/workspace/issue-properties'
import { activityLabel, groupThreads, lastActivity, THREAD_GROUPS, type ThreadGroup, type ThreadRowOf } from '@/lib/thread-groups'
import { cn } from '@/lib/utils'
import { HarnessMark } from '@/components/labels/entity-labels'
import { GroupHeader } from './group-header'
import { ThreadStatusIcon } from '@/components/workspace/thread-status-icon'

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
  if (issue) return [issueIdentifier(issue), issue.title].filter(Boolean).join(' ')
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
 * verbatim. No status word, no bot name. A task's earlier threads fold into
 * its newest; past the first, the line opens with 第 N 次尝试, and the task's
 * page lists them all. The row leads with its status icon and colour, the
 * group's (R-52), as on the phone. In 全部线程 the mark of the Agent running it
 * (R-78; a neutral thread mark when unknown, never the bot's avatar) and the
 * last activity sit on the right.
 */
function ThreadRow({ thread, group, issues, all, now, onOpenThread }: { thread: ThreadRowOf<Thread>; group: ThreadGroup; issues: Issue[]; all: boolean; now: Date; onOpenThread: (thread: { issueId: string; runId: string }) => void }) {
  const t = useTranslations('Shell.threads')
  const format = useFormatter()
  const name = threadName(thread, issues, t('untitled'))
  const at = new Date(lastActivity(thread))
  const when = activityLabel(at, now)
  const waiting = thread.status === 'queued' ? (thread as ThreadView).waitingFor : undefined
  const body = <>
    <span className="flex w-full min-w-0 items-center gap-2">
      <span data-slot="thread-status" className="flex size-4 shrink-0 items-center justify-center"><ThreadStatusIcon group={group} small /></span>
      <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
      {all && <span data-slot="thread-agent" className="flex shrink-0 items-center text-muted-foreground opacity-80 [&_svg]:size-3">{thread.harness ? <HarnessMark harness={thread.harness} /> : <ThreadMark size="row" />}</span>}
      {all && <span className="shrink-0 text-xs text-muted-foreground">{when === 'relative' ? format.relativeTime(at, now) : t(when)}</span>}
    </span>
    {waiting
      ? <span className="flex w-full min-w-0 pl-6"><WaitingChip waiting={waiting} /></span>
      : (thread.lastReply || thread.attempts > 1) && <span className="block w-full truncate pl-6 text-xs text-muted-foreground">{[thread.attempts > 1 ? t('attempt', { count: thread.attempts }) : null, thread.lastReply].filter(Boolean).join(' · ')}</span>}
  </>
  return <li>
    {thread.issueId
      ? <Button variant="ghost" className={TWO_LINE_ROW} aria-label={name} onClick={() => onOpenThread({ issueId: thread.issueId!, runId: thread.id })}>{body}</Button>
      : <div className={TWO_LINE_ROW}>{body}</div>}
  </li>
}

/**
 * The right column's thread list (R-52): 进行中 → 受阻 → 等待你 → 空闲 →
 * 已解决, each with its count; 已解决 starts collapsed. Outside 进行中 the
 * judged outcome places a thread, so a failed or blocked run never reads as
 * resolved. Picking a thread opens it in the centre, as a thread card does;
 * the chat stays one click away (R-50, R-66).
 */
export function ThreadList({ threads, issues, all = false, onOpenThread }: { threads: Thread[]; issues: Issue[]; all?: boolean; onOpenThread: (thread: { issueId: string; runId: string }) => void }) {
  const t = useTranslations('Shell.threads')
  // One clock for every row's time.
  const now = useNow({ updateInterval: 60_000 })
  if (!threads.length) return <p className="px-2 py-6 text-center text-xs text-muted-foreground">{t('empty')}</p>
  const groups = groupThreads(threads, id => issues.find(issue => issue.id === id))
  const rows = (list: ThreadRowOf<Thread>[], group: ThreadGroup) => <ul className="flex flex-col">{list.map(thread => <ThreadRow key={thread.id} thread={thread} group={group} issues={issues} all={all} now={now} onOpenThread={onOpenThread} />)}</ul>
  return <div role="group" aria-label={t('title')} className="flex flex-col gap-3">
    {THREAD_GROUPS.map(group => {
      const list = groups[group]
      if (!list.length) return null
      const label = t(`group.${group}`, { count: list.length })
      if (group === 'resolved') return <Collapsible key={group} className="flex flex-col gap-1">
        <CollapsibleTrigger render={<Button variant="ghost" className="group flex h-auto w-full p-0 text-left font-normal hover:bg-transparent" />}>
          <GroupHeader>{label}<ChevronRight aria-hidden="true" className="size-3.5 transition-transform group-data-panel-open:rotate-90" /></GroupHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>{rows(list, group)}</CollapsibleContent>
      </Collapsible>
      return <section key={group} aria-label={label} className="flex flex-col gap-1"><GroupHeader>{label}</GroupHeader>{rows(list, group)}</section>
    })}
  </div>
}
