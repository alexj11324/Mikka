'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import useSWR from 'swr'
import { motion } from 'motion/react'
import { useTranslations } from 'next-intl'
import { Clock, FileText, Maximize2, Minimize2, Search, X, type LucideIcon } from 'lucide-react'
import type { listIssues } from '@/app/actions/issues'
import type { Thread } from '@/app/actions/task-runs'
import { listBots } from '@/app/actions/bots'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { PR_GROUPS, pullRequestsOf } from '@/lib/thread-groups'
import { cn } from '@/lib/utils'
import { SPRING_SIDEBAR } from '@/lib/ease'
import { LetterAvatar } from './letter-avatar'
import { AgentComputer } from '@/components/computer/agent-computer'
import { useConversationThread } from '@/components/computer/computer-agents'
import { BotAvatar, COORDINATOR_AVATAR } from './bot-avatar'
import { BotLookEditor } from './bot-look-editor'
import { BotNameEditor } from './bot-name-editor'
import { GroupHeader } from './group-header'
import { ThreadList, TWO_LINE_ROW } from './thread-list'
import { issueIdentifier } from '@/components/workspace/issue-properties'
import { PullRequestIcon } from '@/components/workspace/pull-request-icon'
import { useCloudComputer, useComputerTab } from '@/hooks/use-feature-availability'
import { RESIZE_EDGE, useResizableWidth } from '@/hooks/use-resizable-width'

type Issue = Awaited<ReturnType<typeof listIssues>>[number]
type PanelView = 'overview' | 'all'
export type PanelTab = 'details' | 'threads' | 'prs' | 'computer'
const TABS: readonly PanelTab[] = ['details', 'threads', 'prs', 'computer']
const PANEL_WIDTH = { storageKey: 'mikka:context-panel-width', min: 320, max: 'half', initial: 360, edge: 'start' } as const
const WIDE = 520

/** A read-only row in 详情: a routine or a library file. */
type DetailItem = { id: string; label: string }
/** Rows shown before 「展开」. */
const COLLAPSED_ROWS = 5
// Nothing stores a bot's routines or library files yet; the lists fill once something does.
const NO_ITEMS: DetailItem[] = []

/** One read-only list in 详情 (Figma 402:5699). Routines are set up in chat and files come in through the composer's 「+」, so there is no button here, only 「展开」. */
function DetailList({ title, empty, items, icon: Icon }: { title: string; empty: string; items: DetailItem[]; icon: LucideIcon }) {
  const t = useTranslations('Shell.panel')
  const [expanded, setExpanded] = useState(false)
  const shown = expanded ? items : items.slice(0, COLLAPSED_ROWS)
  // R-52's group header, as in 线程 and PR.
  return <section aria-label={title} className="flex flex-col gap-1">
    <GroupHeader>{title}</GroupHeader>
    {items.length ? <div className="flex flex-col rounded-2xl bg-muted/60 p-1.5">
      <ul className="flex flex-col">{shown.map(item => <li key={item.id} className="flex min-w-0 items-center gap-2.5 px-2.5 py-1.5 text-sm"><Icon aria-hidden="true" className="size-4 shrink-0" /><span className="truncate">{item.label}</span></li>)}</ul>
      {items.length > COLLAPSED_ROWS && !expanded && <Button variant="ghost" size="sm" className="self-center font-normal text-muted-foreground" onClick={() => setExpanded(true)}>{t('expand')}</Button>}
    </div> : <p className="px-2 py-1.5 text-xs text-muted-foreground">{empty}</p>}
  </section>
}

/** PR: the bot's pull requests by 等待审查 / 进行中 / 已合并, each its task's title and the PR's number (Figma 422:5820). */
function PullRequests({ threads, issues }: { threads: Thread[]; issues: Issue[] }) {
  const t = useTranslations('Shell.panel')
  const rows = pullRequestsOf(threads, issues)
  if (!rows.length) return <p className="px-2 text-xs text-muted-foreground">{t('noPullRequests')}</p>
  return <div className="flex flex-col gap-3">
    {PR_GROUPS.map(group => {
      const list = rows.filter(row => row.group === group)
      if (!list.length) return null
      const label = t(`prGroup.${group}`, { count: list.length })
      return <section key={group} aria-label={label} className="flex flex-col gap-1">
        <GroupHeader>{label}</GroupHeader>
        <ul className="flex flex-col">{list.map(row => {
          const issue = issues.find(item => item.id === row.issueId)
          return <li key={row.url}>
            <Button variant="ghost" className={TWO_LINE_ROW} render={<a href={row.url} target="_blank" rel="noreferrer" />} nativeButton={false}>
              <span className="truncate text-sm">{issue?.title}</span>
              <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground"><span className="flex shrink-0 [&_svg]:size-3.5"><PullRequestIcon state={row.state} /></span><span className="truncate">#{row.number}{issue && ` · ${issueIdentifier(issue)}`}</span></span>
            </Button>
          </li>
        })}</ul>
      </section>
    })}
  </div>
}

/** Who the center chat is with. For a bot, `id` is the bot's id; for an older chat, the chat's id. */
export type PanelConversation = { id?: string | null; name: string; color?: string; shape?: string; kind: 'coordinator' | 'bot' | 'agent'; updatedAt?: string }

/**
 * The right column beside a chat, read-only (Figma 395:27702, 445:6126). Its
 * header switches only this column: 概览 shows the bot (avatar and name) with
 * 详情 / 线程 / PR / 电脑; 全部线程 lists every bot's threads. ⤢ widens just
 * this column. Picking another bot switches its threads, PRs and computer.
 */
export function ContextPanel({ issues, threads, conversation, workspaceId, onOpenIssue, onSearch, onClose, sheet = false }: {
  issues: Issue[]
  threads: Thread[]
  conversation: PanelConversation
  /** The current workspace; its E2B key decides whether the 电脑 tab shows the screen or 添加 E2B API Key. */
  workspaceId?: string
  onOpenIssue: (id: string) => void
  onSearch: () => void
  onClose: () => void
  /** Shown in a Sheet below xl, where the column has no room. */
  sheet?: boolean
}) {
  const t = useTranslations('Shell.panel')
  const [view, setView] = useState<PanelView>('overview')
  const [tab, setTab] = useState<PanelTab>('threads')
  const { width, max, dragging, resizeTo, reset, handleProps } = useResizableWidth(PANEL_WIDTH)
  // 加宽 remembers the width it replaced, and the button puts it back.
  const [beforeWide, setBeforeWide] = useState<number | null>(null)
  const wide = beforeWide !== null
  function toggleWide() {
    if (wide) { resizeTo(beforeWide); setBeforeWide(null); return }
    setBeforeWide(width)
    resizeTo(width >= WIDE ? max : WIDE)
  }
  const asideRef = useRef<HTMLElement>(null)
  // The content keeps the panel's full width while it opens or closes, so it is clipped, not squeezed.
  useLayoutEffect(() => { asideRef.current?.style.setProperty('--context-panel-width', `${width}px`) }, [width])
  const { data: bots = [] } = useSWR('bots', listBots)
  const botId = conversation.kind === 'bot' ? conversation.id ?? null : null
  const coordinator = conversation.kind === 'coordinator'
  // A bot's own threads; the Coordinator's are the ones it dispatched: no bot on the run, and not from an MCP client.
  const ownThreads = botId ? threads.filter(thread => thread.botId === botId) : coordinator ? threads.filter(thread => !thread.botId && thread.source !== 'mcp') : []
  // An older chat without a bot learns its thread from the 电脑 cards in it.
  const cloudComputer = useCloudComputer()
  const registered = useConversationThread(cloudComputer && conversation.kind === 'agent' ? conversation.id : null)
  // Every bot has the 电脑 tab (Alex, 2026-10-31); without a key it offers 添加 E2B API Key.
  const computerTab = useComputerTab()
  const computer = (computerTab ? botId : null) ?? (cloudComputer ? registered?.botId : undefined)
  // A conversation whose bot works on its computer opens on its screen (Figma 103:64).
  useEffect(() => { if (registered?.runId) { setView('overview'); setTab('computer') } }, [registered?.runId])
  // No computer here (the kill switch is on, or the Coordinator): no 电脑 tab.
  const tabs = computer ? TABS : TABS.filter(item => item !== 'computer')
  const shown = tabs.includes(tab) ? tab : 'threads'

  const pill = 'h-7 flex-none rounded-full px-2.5 font-normal text-muted-foreground data-active:bg-muted! data-active:text-foreground data-active:shadow-none'
  // The panel keeps its transparent pills while Alex compares them with the shared segmented control (docs/design/decisions/2026-10-31-1814-segmented-control-motion.md);
  // `indicator: false` opts out of the gliding pill. To switch, drop `pillTab` and the list overrides.
  const pillTab = { className: pill, indicator: false }
  // R-37: opening, closing and widening move the width on a spring; while the edge is dragged
  // the width follows the pointer with no spring.
  return <motion.aside ref={asideRef} aria-label={t('label')} initial={sheet ? false : { width: 0 }} animate={sheet ? undefined : { width }} exit={sheet ? undefined : { width: 0 }} transition={dragging ? { duration: 0 } : SPRING_SIDEBAR} className={cn('relative min-h-0 shrink-0 flex-col', sheet ? 'flex size-full' : 'hidden overflow-hidden border-l bg-background xl:flex', dragging && 'select-none')}>
    {/* Drag the inner edge or use the arrow keys on it to resize the panel; double-click it to reset. */}
    {!sheet && <div {...handleProps} aria-label={t('resize')} onDoubleClick={() => { setBeforeWide(null); reset() }} className={cn(RESIZE_EDGE, 'absolute inset-y-0 start-0 after:start-0')} />}
    <Tabs value={view} onValueChange={value => setView(value as PanelView)} className={cn('min-h-0 flex-1 gap-0', !sheet && 'min-w-[var(--context-panel-width,22.5rem)]')}>
      <div className="flex h-11 shrink-0 items-center gap-1 px-3">
        <TabsList aria-label={t('views')} className="gap-1 bg-transparent p-0">
          <TabsTrigger value="overview" {...pillTab}>{t('overview')}</TabsTrigger>
          <TabsTrigger value="all" {...pillTab}>{t('allThreads')}</TabsTrigger>
        </TabsList>
        <div className="ml-auto flex items-center">
          <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t('search')} onClick={onSearch} />}><Search data-icon="inline-start" /></TooltipTrigger><TooltipContent>{t('search')}</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={wide ? t('narrow') : t('widen')} aria-pressed={wide} className={cn(sheet && 'hidden')} onClick={toggleWide} />}>{wide ? <Minimize2 data-icon="inline-start" /> : <Maximize2 data-icon="inline-start" />}</TooltipTrigger><TooltipContent>{wide ? t('narrow') : t('widen')}</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t('close')} onClick={onClose} />}><X data-icon="inline-start" /></TooltipTrigger><TooltipContent>{t('close')}</TooltipContent></Tooltip>
        </div>
      </div>
      <TabsContent value="overview" className="flex min-h-0 flex-col">
        <Tabs value={shown} onValueChange={value => setTab(value as PanelTab)} className="min-h-0 flex-1 gap-0">
          <div className="flex shrink-0 flex-col items-center gap-3 px-4 pt-9 pb-4">
            {/* A bot's name and look are edited in place; the Coordinator is not a bot row, so it stays as it is. */}
            {botId ? <BotLookEditor botId={botId} name={conversation.name} color={conversation.color} shape={conversation.shape} />
              : coordinator ? <BotAvatar {...COORDINATOR_AVATAR} size="profile" /> : <LetterAvatar name={conversation.name} size="profile" />}
            {botId ? <BotNameEditor key={botId} botId={botId} name={conversation.name} /> : <h2 className="max-w-full truncate text-xl font-semibold">{conversation.name}</h2>}
            <TabsList aria-label={t('tabs')} className="mt-2 gap-1 bg-transparent p-0">
              {tabs.map(item => <TabsTrigger key={item} value={item} {...pillTab}>{t(item)}</TabsTrigger>)}
            </TabsList>
          </div>
          <TabsContent value="details" className="flex min-h-0 flex-col gap-3 overflow-y-auto px-4 pb-4">
            <DetailList title={t('routines')} empty={t('noRoutines')} items={NO_ITEMS} icon={Clock} />
            <DetailList title={t('library')} empty={t('noLibrary')} items={NO_ITEMS} icon={FileText} />
          </TabsContent>
          <TabsContent value="threads" className="min-h-0 overflow-y-auto px-4 pb-4">
            <ThreadList threads={ownThreads} issues={issues} bots={bots} onOpenIssue={onOpenIssue} />
          </TabsContent>
          <TabsContent value="prs" className="min-h-0 overflow-y-auto px-4 pb-4">
            <PullRequests threads={ownThreads} issues={issues} />
          </TabsContent>
          {computer && <TabsContent value="computer" className="min-h-0 overflow-y-auto px-4 pb-4">
            {botId ? <AgentComputer botId={botId} name={conversation.name} header={false} workspaceId={workspaceId} /> : registered && <AgentComputer key={registered.runId} botId={registered.botId} name={registered.botName} header={false} workspaceId={workspaceId} />}
          </TabsContent>}
        </Tabs>
      </TabsContent>
      <TabsContent value="all" className="min-h-0 overflow-y-auto px-4 py-3">
        <ThreadList threads={threads} issues={issues} bots={bots} all onOpenIssue={onOpenIssue} />
      </TabsContent>
    </Tabs>
  </motion.aside>
}
