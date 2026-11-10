'use client'

import * as taskConversationSlot from '@ui-slot/task-conversation'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { authClient } from '@/lib/auth-client'
import { findThreadIssue, type IssueThreadDetail } from '@/app/actions/agents'
import { Skeleton } from '@/components/ui/skeleton'
import { InlineLoadError } from '@/components/load-error'
import { TaskDetailPlacementContext } from '@/components/slots/task-detail-contract'
import type { ThreadPanelTab, ThreadScreenProps } from '@/components/slots/thread-contract'
import { NAVIGATE_EVENT, navigate, openThread, readLocation, setWorkAreaOpener } from '@/components/workspace/workspace-navigation'

/**
 * The right-hand tabs a page hands its chat when the frame owns the panel (FRAME_OWNS_PANEL): the Overview
 * and the browser travel to the conversation's work area instead of a column beside it.
 */
export const ConversationPanels = createContext<ThreadScreenProps['panels'] | undefined>(undefined)
export const useConversationPanels = () => useContext(ConversationPanels)

// The task view and a thread's conversation load with their first tab, not with the chat.
const TaskDetail = dynamic(() => import('@/components/workspace/task-detail').then(module => module.TaskDetail), { loading: () => <TabLoading /> })
const IssueThreadPanel = dynamic(() => import('@/components/workspace/issue-thread-panel').then(module => module.IssueThreadPanel), { loading: () => <TabLoading /> })

function TabLoading() {
  return <div role="status" className="flex flex-col gap-3 p-4"><Skeleton className="h-6 w-2/3" /><Skeleton className="h-24 w-full" /></div>
}

const NO_PAGER = { index: -1, total: 0, onOpen: () => {} }
const nothing = () => {}

/** A task in the chat's work area: the task page's own view, narrow; expand opens the full page (decision 2026-11-10). */
function TaskTab({ issueId, origin, onOpenTask, onFlush }: { issueId: string; origin: string; onOpenTask: (id: string) => void; onFlush: (issueId: string, flush: (() => Promise<boolean>) | null) => void }) {
  const t = useTranslations('Shell.panel.task')
  const { data: session } = authClient.useSession()
  // Expand saves what is still being written first, as leaving the task page does; a save that fails keeps the tab.
  const flush = useRef<(() => Promise<boolean>) | null>(null)
  const registerFlush = useCallback((next: (() => Promise<boolean>) | null) => { flush.current = next; onFlush(issueId, next) }, [issueId, onFlush])
  const placement = useMemo(() => ({
    onExpand: () => { void (flush.current?.() ?? Promise.resolve(true)).then(saved => { if (saved) navigate({ issue: issueId }) }, () => {}) },
    expandLabel: t('openPage'),
  }), [issueId, t])
  const user = session?.user
  if (!user) return <TabLoading />
  return <TaskDetailPlacementContext value={placement}>
    <TaskDetail id={issueId} thread={null} origin={origin} user={{ id: user.id, name: user.name, email: user.email }} navigation={NO_PAGER}
      onOpen={onOpenTask} onSaved={nothing} onDirty={nothing} onClose={nothing} onDeleted={nothing} onRegisterFlush={registerFlush} />
  </TaskDetailPlacementContext>
}

/**
 * A thread in the chat's work area: its task's one conversation at this attempt (task-conversation slot), else the
 * thread's own panel, as the right column drew it (components/workspace/thread-column.tsx). ← and its task link open
 * the task's tab; a thread it names (a subagent, a review) opens a tab of its own.
 */
function ThreadTab({ runId, issueId: known, name, onOpenTask, onTitle }: { runId: string; issueId?: string | null; name?: string; onOpenTask: (id: string) => void; /** A thread the chat does not know names its tab once read. */ onTitle?: (runId: string, title: string) => void }) {
  const t = useTranslations('IssueThreads')
  const { data: looked, error, mutate } = useSWR(known ? null : ['thread-issue', runId], () => findThreadIssue(runId))
  useThreadTitle(known ?? looked?.issueId ?? null, runId, onTitle)
  if (!known && looked === undefined) return error ? <div className="p-4"><InlineLoadError message={t('loadFailed')} retryLabel={t('retry')} onRetry={() => { void mutate() }} /></div> : <TabLoading />
  if (!known && looked === null) return <div className="p-4"><InlineLoadError message={t('loadFailed')} retryLabel={t('retry')} onRetry={() => { void mutate() }} /></div>
  const issueId = known ?? looked?.issueId ?? null
  const TaskConversation = taskConversationSlot.TaskConversation ?? null
  const toTask = issueId ? () => onOpenTask(issueId) : undefined
  return TaskConversation && issueId && toTask
    ? <TaskConversation key={issueId} issueId={issueId} runId={runId} name={name} onBack={toTask} onOpenThread={openThread} onOpenTask={toTask} />
    : <IssueThreadPanel key={runId} issueId={issueId} runId={runId} name={name} onOpenThread={openThread} onOpenTask={toTask} />
}

/**
 * "<code> › <title>" for a thread the chat has no source for: its name from the conversation's own read of it (the
 * panel's `issue-thread` key, read here without a fetch of its own) and its task's code.
 */
function useThreadTitle(issueId: string | null, runId: string, onTitle?: (runId: string, title: string) => void) {
  const on = Boolean(onTitle && issueId)
  const { data: thread } = useSWR<IssueThreadDetail>(on ? ['issue-thread', issueId, runId] : null, null)
  const { data: issue } = useSWR(on ? ['work-tab-issue', issueId] : null, () => import('@/app/actions/issues').then(actions => actions.getIssue(issueId!)), { revalidateOnFocus: false })
  const code = issue && !issue.error ? issue.issue.identifier : null
  const name = thread?.thread.detail?.name || thread?.thread.prompt.trim() || (issue && !issue.error ? issue.issue.title : null)
  const title = code && name ? `${code} › ${name}` : name || code
  useEffect(() => { if (title) onTitle?.(runId, title) }, [title, runId, onTitle])
}

type Opened = { kind: 'task' | 'thread'; id: string }
/** What a tab is called and, for a thread, the task it works on when the chat knows it. */
export type WorkTabNames = { task: (issueId: string) => string; thread: (runId: string) => { title: string; issueId?: string | null; name?: string } }

/**
 * The tabs a chat opens in its own work area (FRAME_OWNS_PANEL, decision 2026-11-10): a task card, a task chip or a
 * task row opens the task's view; a thread chip, an Agent's stretch or a subagent opens that thread's conversation.
 * Each opens once and comes to the front when asked again; its × closes it. While `on`, every task or thread opened on
 * the page comes here (workspace-navigation's setWorkAreaOpener), and an old address that names one (`?task=`,
 * `?thread=`) opens its tab instead of a column beside the chat.
 */
export function useWorkTabs(on: boolean, names: WorkTabNames, origin: string) {
  const flushes = useRef(new Map<string, () => Promise<boolean>>())
  const registerFlush = useCallback((issueId: string, flush: (() => Promise<boolean>) | null) => {
    if (flush) flushes.current.set(issueId, flush)
    else flushes.current.delete(issueId)
  }, [])
  const beforeClose = useCallback(async (tabId: string) => {
    const flush = tabId.startsWith('task:') ? flushes.current.get(tabId.slice(5)) : undefined
    return flush ? await flush() : true
  }, [])
  const [opened, setOpened] = useState<Opened[]>([])
  const [reveal, setReveal] = useState<{ reveal: number; revealId: string | null }>({ reveal: 0, revealId: null })
  const open = useCallback((kind: Opened['kind'], id: string) => {
    setOpened(list => list.some(item => item.kind === kind && item.id === id) ? list : [...list, { kind, id }])
    setReveal(value => ({ reveal: value.reveal + 1, revealId: `${kind}:${id}` }))
  }, [])
  const openTask = useCallback((id: string) => open('task', id), [open])
  const openRun = useCallback((id: string) => open('thread', id), [open])
  const [learned, setLearned] = useState<Record<string, string>>({})
  const learn = useCallback((runId: string, title: string) => setLearned(current => current[runId] === title ? current : { ...current, [runId]: title }), [])
  useEffect(() => {
    if (!on) return
    const release = setWorkAreaOpener({ task: openTask, thread: openRun })
    const take = () => {
      const { task, thread } = readLocation(new URL(window.location.href).searchParams)
      if (!task && !thread) return
      if (thread) openRun(thread)
      else if (task) openTask(task)
      navigate({ task: null, thread: null }, 'replace')
    }
    take()
    window.addEventListener('popstate', take)
    window.addEventListener(NAVIGATE_EVENT, take)
    return () => { release(); window.removeEventListener('popstate', take); window.removeEventListener(NAVIGATE_EVENT, take) }
  }, [on, openTask, openRun])
  const tabs = opened.map((item): ThreadPanelTab => {
    if (item.kind === 'task') return { id: `task:${item.id}`, title: names.task(item.id), content: <TaskTab key={item.id} issueId={item.id} origin={origin} onOpenTask={openTask} onFlush={registerFlush} /> }
    const thread = names.thread(item.id)
    // A run the chat has no source for (opened from the Overview, search or another thread) learns its title once read.
    const unknown = thread.issueId === undefined
    return { id: `thread:${item.id}`, title: (unknown && learned[item.id]) || thread.title,
      content: <ThreadTab key={item.id} runId={item.id} issueId={thread.issueId} name={thread.name} onOpenTask={openTask} onTitle={unknown ? learn : undefined} /> }
  })
  const work: ThreadScreenProps['work'] = on ? { tabs, ...reveal, beforeClose } : undefined
  return { work, openTask }
}
