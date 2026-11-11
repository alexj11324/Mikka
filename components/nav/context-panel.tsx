'use client'

import { useEffect, useLayoutEffect, useRef } from 'react'
import { useTranslations } from 'next-intl'
import type { listIssues } from '@/app/actions/issues'
import type { Thread } from '@/app/actions/task-runs'
import { cn } from '@/lib/utils'
import { useConversationThread } from '@/components/computer/computer-agents'
import { BotOverviewBody } from './bot-overview'
import { ThreadList, threadName } from './thread-list'
import { useCloudComputer, useComputerTab } from '@/hooks/use-feature-availability'
import { useResizableWidth } from '@/hooks/use-resizable-width'
import { usePanelInitialWidth } from '@/hooks/use-panel-width'
import { ResizeHandle } from '@/components/ui/resizable-pane'
import { useViewScroll, useViewState } from '@/lib/hooks/view-state'
import { BotTasks } from '@ui-slot/bot-tasks'
import * as botTasksSlot from '@ui-slot/bot-tasks'
import { PanelHeader } from '@ui-slot/panel-header'
import { openTask } from '@/components/workspace/workspace-navigation'

type Issue = Awaited<ReturnType<typeof listIssues>>[number]
export type PanelTab = 'details' | 'threads' | 'prs' | 'computer'
const TABS: readonly PanelTab[] = ['details', 'threads', 'prs', 'computer']
/** The right column's width, shared by 概览 and an open thread (R-82): one column, one remembered width. */
export const PANEL_WIDTH = { storageKey: 'mikka:context-panel-width', min: 320, max: 'half', initial: 360, edge: 'start' } as const
const WIDE = 520

/** Whether `text` contains the panel search's query, ignoring case. An empty query matches everything. */
export function matches(query: string, ...texts: (string | null | undefined)[]) {
  const needle = query.trim().toLocaleLowerCase()
  return !needle || texts.some(text => text?.toLocaleLowerCase().includes(needle))
}

/** A thread list under the panel search: 无匹配结果 when the query hides every thread, else the list as usual. */
export function ThreadResults({ threads, shown, ...props }: Omit<Parameters<typeof ThreadList>[0], 'threads'> & { threads: Thread[]; shown: Thread[] }) {
  const t = useTranslations('Shell.panel')
  if (threads.length && !shown.length) return <p className="px-2 py-6 text-center text-xs text-muted-foreground">{t('noMatches')}</p>
  return <ThreadList threads={shown} {...props} />
}

/** Who the center chat is with. For a bot, `id` is the bot's id; for an older chat, the chat's id. */
export type PanelConversation = { id?: string | null; name: string; color?: string; shape?: string; kind: 'coordinator' | 'bot' | 'agent'; updatedAt?: string }

/**
 * The right column beside a chat (Figma 395:27702, 445:6126): 概览,
 * the bot (avatar and name) with 详情 / 线程 / PR / 电脑. 线程 lists the threads
 * this bot dispatched; the threads every bot dispatched are 全部线程, opened
 * from the window bar on any page (R-82), so this column has no tab for them.
 * ⤢ widens just this column. Picking another bot switches the threads it
 * dispatched, its PRs and its computer.
 */
export function ContextPanel({ issues, threads, threadsLoading = false, conversation, workspaceId, onOpenThread, onOpenTask, onClose, sheet = false, frameTab = false }: {
  issues: Issue[]
  threads: Thread[]
  /** The thread list has not been read yet (review C7). */
  threadsLoading?: boolean
  conversation: PanelConversation
  /** The current workspace; its E2B key decides whether the 电脑 tab shows the screen or 添加 E2B API Key. */
  workspaceId?: string
  /** A thread row opens that thread in the centre column (R-50: the panel never replaces the chat with a task page). */
  onOpenThread: (thread: { issueId: string | null; runId: string }) => void
  /** Before a task row opens its task in the right column (the sheet closes itself). */
  onOpenTask?: () => void
  onClose: () => void
  /** Shown in a Sheet below xl, where the column has no room. */
  sheet?: boolean
  /** The 概览 tab of the conversation's work area (FRAME_OWNS_PANEL): the tab supplies its header. */
  frameTab?: boolean
}) {
  const t = useTranslations('Shell.panel')
  const stateKey = `context:${conversation.kind}:${conversation.id ?? 'coordinator'}`
  const [tab, setTab] = useViewState<PanelTab>(`${stateKey}:tab`, 'threads')
  const [tabChosen, setTabChosen] = useViewState(`${stateKey}:tab-chosen`, false)
  // The header's search filters this column's lists in place (R-50); null while it is closed.
  const [query, setQuery] = useViewState<string | null>(`${stateKey}:query`, null)
  const filter = (list: Thread[]) => query ? list.filter(thread => matches(query, threadName(thread, issues, ''), thread.lastReply)) : list
  // A UI layer may size the default from the main area (panel-header slot); a remembered width still wins.
  const resize = useResizableWidth({ ...PANEL_WIDTH, initial: usePanelInitialWidth(PANEL_WIDTH.initial) })
  const { width, max, dragging, resizeTo } = resize
  // 加宽 remembers the width it replaced, and the button puts it back.
  const [beforeWide, setBeforeWide] = useViewState<number | null>('context:before-wide', null)
  const wide = beforeWide !== null
  function toggleWide() {
    if (wide) { resizeTo(beforeWide); setBeforeWide(null); return }
    setBeforeWide(width)
    resizeTo(width >= WIDE ? max : WIDE)
  }
  const asideRef = useRef<HTMLElement>(null)
  // The panel's width, also the content's minimum, so the content is clipped, not squeezed, when the window is narrow.
  useLayoutEffect(() => { asideRef.current?.style.setProperty('--context-panel-width', `${width}px`) }, [width])
  // Only an ordinary bot's name and look are edited here; the Coordinator keeps its own.
  const botId = conversation.kind === 'bot' ? conversation.id ?? null : null
  const coordinator = conversation.kind === 'coordinator'
  // The chat's bot row, the Coordinator's included: its threads and its computer are that row's.
  const chatBotId = botId ?? (coordinator ? conversation.id ?? null : null)
  // An MCP client's runs are the Coordinator's too, but its panel lists only the threads it dispatched, as before.
  const ownThreads = chatBotId ? threads.filter(thread => thread.botId === chatBotId && thread.source !== 'mcp') : []
  // An older chat without a bot learns its thread from the 电脑 cards in it.
  const cloudComputer = useCloudComputer()
  const registered = useConversationThread(cloudComputer && conversation.kind === 'agent' ? conversation.id : null)
  // Every bot has the 电脑 tab (Alex, 2026-10-31); without a key it offers 添加 E2B API Key.
  const computerTab = useComputerTab()
  const computer = (computerTab ? chatBotId : null) ?? (cloudComputer ? registered?.botId : undefined)
  // A conversation whose bot works on its computer opens on its screen (Figma 103:64).
  useEffect(() => { if (registered?.runId && !tabChosen) { setTab('computer'); setTabChosen(true) } }, [registered?.runId, tabChosen, setTab, setTabChosen])
  // No computer here (the kill switch is on): no 电脑 tab.
  const tabs = computer ? TABS : TABS.filter(item => item !== 'computer')
  const shown = tabs.includes(tab) ? tab : 'threads'
  const scrollKey = shown === 'details' ? `${stateKey}:details` : `${stateKey}:${shown}:${query ?? ''}`
  const standaloneScroll = useViewScroll<HTMLDivElement>(scrollKey, !frameTab && (shown !== 'threads' || !threadsLoading))

  const tasks = <BotTasks workspaceId={workspaceId} botId={chatBotId} stateKey={stateKey} threads={ownThreads} shown={filter(ownThreads)} issues={issues} query={query ?? ''} loading={threadsLoading} onOpenThread={onOpenThread} onOpenTask={id => { onOpenTask?.(); openTask(id) }} />
  const body = <BotOverviewBody conversation={conversation} workspaceId={workspaceId} threads={ownThreads} issues={issues} tasks={tasks}
    tabs={tabs.map(item => ({ id: item, label: item === 'threads' && botTasksSlot.LISTS_TASKS ? t('tasks') : t(item) }))} tab={shown} onTab={value => { setTab(value); setTabChosen(true) }}
    query={query} onQuery={setQuery}
    computer={!computer ? null : chatBotId ? { botId: chatBotId, name: conversation.name } : registered ? { botId: registered.botId, name: registered.botName } : null} />

  if (frameTab) return body

  // R-37: opening, closing and widening are instant, no motion (decision 2026-11-01-2320); dragging the edge follows the pointer.
  return <aside ref={asideRef} aria-label={t('label')} className={cn('relative min-h-0 shrink-0 flex-col', sheet ? 'flex size-full' : 'hidden w-(--context-panel-width) overflow-hidden border-l bg-background xl:flex', dragging && 'select-none')}>
    {/* Drag the inner edge or use the arrow keys on it to resize the panel; double-click it to reset. */}
    {!sheet && <ResizeHandle resize={resize} label={t('resize')} edge="start" onDoubleClick={() => setBeforeWide(null)} />}
    <div className={cn('flex min-h-0 flex-1 flex-col', !sheet && 'min-w-[var(--context-panel-width,22.5rem)]')}>
      <PanelHeader variant="context" title={t('overview')} onClose={onClose} actions={[]}
        widen={sheet ? undefined : { wide, onToggle: toggleWide }} />
      <div ref={standaloneScroll} className="min-h-0 flex-1 overflow-y-auto">{body}</div>
    </div>
  </aside>
}
