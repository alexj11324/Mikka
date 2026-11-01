'use client'

import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import useSWR from 'swr'
import { motion } from 'motion/react'
import { useTranslations } from 'next-intl'
import { PanelLeft, Plus, Users } from 'lucide-react'
import { botChatSummaries, getCoordinatorChat, type CoordinatorChat } from '@/app/actions/coordinator'
import type { BotView } from '@/app/actions/bots'
import type { Thread } from '@/app/actions/task-runs'
import type { listIssues } from '@/app/actions/issues'
import { botAttention } from '@/lib/bot-mood'
import { MikkaMark } from '@/components/brand/mikka-mark'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar'
import { WorkspaceMenu } from '@/components/workspace-menu'
import { cn } from '@/lib/utils'
import { useResizableWidth } from '@/hooks/use-resizable-width'
import { ResizeHandle } from '@/components/ui/resizable-pane'
import { SPRING_SIDEBAR } from '@/lib/ease'
import { chatPreview } from '@/lib/agent-history'
import { fetchGroups } from '@/lib/group-messages'
import { namedCitations } from '@/lib/coordinator/citations'
import { RAIL_ITEMS, type RailDestination } from './icon-rail'
import { BotAvatar, CoordinatorAvatar, type BotMood } from './bot-avatar'

/**
 * What the center column shows: the Coordinator, a bot's chat (both on the
 * Coordinator harness), or a read-only older chat (reachable from ⌘K only).
 */
export type ChatTarget = { kind: 'coordinator' } | { kind: 'bot'; botId: string } | { kind: 'agent'; sessionId: string | null } | { kind: 'group'; id: string; title: string; workspaceId: string }

type Issue = Awaited<ReturnType<typeof listIssues>>[number]

type ListProps = {
  bots: BotView[]
  /** The workspace whose group chats are listed with the bots (R-01). */
  workspaceId: string | null
  threads: Thread[]
  /** The tasks the threads work on: a closed task or merged PR settles a thread, as in the right column. */
  issues: Issue[]
  active: ChatTarget | null
  onOpen: (target: ChatTarget) => void
  onNewBot: () => void
  rail: RailDestination | null
  onRail: (destination: RailDestination) => void
  user: { name: string; email: string; image?: string | null }
  onSettings: (href?: string) => void
  onSignOut: () => void
  signingOut: boolean
  onBeforeChange?: (action: () => Promise<void>) => void
  /** Only on a phone, where the list's sheet is the way off a full page (the board, 建议…); desktop keeps those pages to the rail (MIK-45). */
  phoneOnly?: boolean
}

// Linear's sidebar range; the width is remembered on this device.
const LIST_WIDTH = { storageKey: 'mikka:bot-list-width', min: 208, max: 400, initial: 256, edge: 'end' } as const
// A click on the edge folds the list after this long, unless it turns out to be a double-click.
const DOUBLE_CLICK_MS = 250

const SEEN_KEY = 'mikka:conversations-seen'
type Seen = { since: string; at: Record<string, string> }

function readSeen(): Seen {
  try {
    const stored = JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? 'null') as Seen | null
    if (stored?.since) return stored
  } catch { /* storage unavailable */ }
  return { since: new Date().toISOString(), at: {} }
}

/**
 * Unread dots. Nothing on the server records reading yet, so each browser
 * remembers when it last showed a bot's chat; anything newer is unread.
 */
function useUnread(activeId: string | null, latest: Record<string, string>) {
  const [seen, setSeen] = useState<Seen | null>(null)
  const activeLatest = activeId ? latest[activeId] : undefined
  useEffect(() => { setSeen(readSeen()) }, [])
  useEffect(() => {
    if (!activeId) return
    setSeen(current => {
      const next = { ...(current ?? readSeen()), at: { ...(current ?? readSeen()).at, [activeId]: new Date().toISOString() } }
      try { window.localStorage.setItem(SEEN_KEY, JSON.stringify(next)) } catch { /* storage unavailable */ }
      return next
    })
  }, [activeId, activeLatest])
  return (id: string) => !!seen && id !== activeId && !!latest[id] && latest[id] > (seen.at[id] ?? seen.since)
}

/** Green while the bot is working, orange while it waits on you; otherwise no dot. */
type RowStatus = 'working' | 'waiting'

/** Hover is one overlay step, the current bot the next one up, so a hovered row never looks selected (R-38). */
const ROW_FILL = 'hover:bg-control active:bg-control data-active:bg-control-hover data-active:hover:bg-control-hover'

function Row({ name, preview, avatar, status, current, unread, onClick, label }: { name: string; preview: ReactNode; avatar: ReactNode; status?: RowStatus; current: boolean; unread: boolean; onClick: () => void; label: string }) {
  return <SidebarMenuItem><SidebarMenuButton size="lg" isActive={current} aria-current={current ? 'page' : undefined} aria-label={label} onClick={onClick} className={cn('h-13 gap-2.5 rounded-xl px-2.5', ROW_FILL)}>
    <span className="relative shrink-0">
      {avatar}
      {status && <span aria-hidden="true" className={cn('absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full ring-2 ring-sidebar', status === 'working' ? 'bg-success' : 'bg-attention')} />}
    </span>
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="truncate text-sm font-semibold">{name}</span>
      {preview && <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">{preview}</span>}
    </span>
    {unread && <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-sidebar-primary" />}
  </SidebarMenuButton></SidebarMenuItem>
}

/**
 * The bot list beside the icon rail (Figma 188:3115): the Coordinator pinned
 * on top, then one row per bot or group chat (R-01) with its avatar, its name
 * and the latest line of its chat, most recent first. Threads (the work a bot does) live in the
 * right column, never here. It collapses off canvas; the rail stays.
 */
export function BotList({ phoneOnly = false, ...props }: ListProps) {
  const { isMobile } = useSidebar()
  return phoneOnly && !isMobile ? null : <BotListBody {...props} />
}

function BotListBody({ bots, workspaceId, threads, issues, active, onOpen, onNewBot, rail, onRail, user, onSettings, onSignOut, signingOut, onBeforeChange }: Omit<ListProps, 'phoneOnly'>) {
  const i18nText = useTranslations()
  const { toggleSidebar, setOpenMobile, open, openMobile, isMobile } = useSidebar()
  const { data: coordinator } = useSWR<CoordinatorChat>('coordinator-chat', () => getCoordinatorChat())
  // Each bot's latest line gives its row the preview and its place in the list.
  const { data: chats = {} } = useSWR('bot-chats', () => botChatSummaries(), { refreshInterval: 15000 })
  // Group chats sit among the bots (R-01), ordered by their latest message.
  const { data: groups = [] } = useSWR(workspaceId ? ['bot-list-groups', workspaceId] : null, ([, id]: [string, string]) => fetchGroups(id), { refreshInterval: 15000 })
  // The Coordinator's bot row is the entry pinned on top; the rest are the person's other bots.
  const rows = [...bots.filter(bot => !bot.coordinator).map(bot => ({ kind: 'bot' as const, bot, at: chats[bot.id]?.at ?? '' })), ...groups.map(group => ({ kind: 'group' as const, group, at: group.lastMessage?.createdAt ?? group.createdAt }))]
    .sort((a, b) => b.at.localeCompare(a.at) || (a.kind === 'bot' ? a.bot.name : a.group.title).localeCompare(b.kind === 'bot' ? b.bot.name : b.group.title))
  const lastReply = coordinator?.items.findLast(item => item.from !== 'event')
  const latest: Record<string, string> = {}
  // The Coordinator's row is read as 'coordinator', from its chat's latest reply below.
  const coordinatorId = bots.find(bot => bot.coordinator)?.id
  for (const [botId, chat] of Object.entries(chats)) if (chat.at && botId !== coordinatorId) latest[botId] = chat.at
  for (const group of groups) if (group.lastMessage) latest[group.id] = group.lastMessage.createdAt
  if (lastReply?.from === 'coordinator') latest.coordinator = lastReply.createdAt
  const activeId = active?.kind === 'coordinator' ? 'coordinator' : active?.kind === 'bot' ? active.botId : active?.kind === 'group' ? active.id : null
  /** One plain line of a message; a card that shows no words reads as the card placeholder. */
  const previewOf = (text: string | null | undefined) => {
    if (!text) return null
    const line = chatPreview(text) ?? i18nText('Nav.cardPreview')
    return line ? <span className="truncate">{line}</span> : null
  }
  const unread = useUnread(activeId, latest)
  const resize = useResizableWidth(LIST_WIDTH)
  const { width, dragging, instant, endedDrag } = resize
  const foldTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(foldTimer.current), [])
  // Enter or a click folds the list; a double-click resets its width instead.
  function onEdgeClick(event: ReactMouseEvent) {
    window.clearTimeout(foldTimer.current)
    if (endedDrag() || event.detail > 1) return
    if (event.detail === 0) toggleSidebar()
    else foldTimer.current = window.setTimeout(toggleSidebar, DOUBLE_CLICK_MS)
  }
  const listRef = useRef<HTMLDivElement>(null)
  // The inner list keeps its full width while the column folds, so rows never squeeze.
  useLayoutEffect(() => { listRef.current?.style.setProperty('--bot-list-width', `${width}px`) }, [width])
  function choose(target: ChatTarget) { onOpen(target); setOpenMobile(false) }
  const body = <>
    <SidebarHeader className="px-3 pt-3 pb-1">
      <div className="flex h-8 items-center gap-1 pl-1">
        <MikkaMark />
        <span className="sr-only">Mikka</span>
        <div className="ml-auto flex items-center gap-1">
          {!isMobile && <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={i18nText('Nav.collapseList')} aria-expanded={isMobile ? openMobile : open} onClick={toggleSidebar} />}><PanelLeft data-icon="inline-start" /></TooltipTrigger><TooltipContent side="bottom">{i18nText('Nav.collapseList')}</TooltipContent></Tooltip>}
          <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={i18nText('Nav.newBot')} onClick={() => { setOpenMobile(false); onNewBot() }} />}><Plus data-icon="inline-start" /></TooltipTrigger><TooltipContent side="bottom">{i18nText('Nav.newBot')}</TooltipContent></Tooltip>
        </div>
      </div>
    </SidebarHeader>
    <SidebarContent>
      <SidebarGroup className="px-2 pt-1"><SidebarMenu aria-label={i18nText('Nav.bots')} className="gap-0.5">
        <Row name={i18nText('Nav.coordinator')} label={coordinator?.working ? i18nText('Nav.coordinatorWorking') : i18nText('Nav.coordinator')} current={active?.kind === 'coordinator'} unread={unread('coordinator')} onClick={() => choose({ kind: 'coordinator' })}
          avatar={<CoordinatorAvatar mood={coordinator?.working ? 'thinking' : 'idle'} />}
          status={coordinator?.working ? 'working' : undefined}
          preview={previewOf(lastReply?.from === 'coordinator' ? namedCitations(lastReply.text, coordinator?.sources ?? {}) : lastReply?.text)} />
        {rows.map(row => {
          if (row.kind === 'group') {
            const { group } = row
            const title = group.title || i18nText('Nav.untitledConversation')
            return <Row key={group.id} name={title} label={title} current={active?.kind === 'group' && active.id === group.id} unread={unread(group.id)} onClick={() => choose({ kind: 'group', id: group.id, title: group.title, workspaceId: group.workspaceId })}
              avatar={<span aria-hidden="true" className="flex size-8.5 items-center justify-center rounded-full bg-muted text-muted-foreground"><Users className="size-4" /></span>}
              preview={previewOf(group.lastMessage?.body)} />
          }
          const { bot } = row
          const chat = chats[bot.id]
          const mood: BotMood = botAttention(threads, bot.id, chat?.working ?? false, id => issues.find(issue => issue.id === id))
          const status: RowStatus | undefined = mood === 'notify' ? 'waiting' : mood === 'thinking' ? 'working' : undefined
          return <Row key={bot.id} name={bot.name} label={bot.name} current={active?.kind === 'bot' && active.botId === bot.id} unread={unread(bot.id)} onClick={() => choose({ kind: 'bot', botId: bot.id })}
            avatar={<BotAvatar color={bot.color} shape={bot.shape} mood={mood} />} status={status}
            preview={previewOf(chat?.line)} />
        })}
      </SidebarMenu></SidebarGroup>
    </SidebarContent>
    {/* Phones have no rail; its destinations (主页 back to the last chat from a full page) and the account menu move here. */}
    {isMobile && <SidebarFooter>
      <SidebarMenu>{RAIL_ITEMS.map(item => <SidebarMenuItem key={item.id}><SidebarMenuButton isActive={rail === item.id} onClick={() => { onRail(item.id); setOpenMobile(false) }}><item.icon /><span>{i18nText(item.label)}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
      <SidebarMenu><SidebarMenuItem><WorkspaceMenu user={user} onSettings={onSettings} onSignOut={onSignOut} signingOut={signingOut} onBeforeChange={onBeforeChange} /></SidebarMenuItem></SidebarMenu>
    </SidebarFooter>}
  </>
  if (isMobile) return <Sidebar collapsible="offcanvas" mobileTitle={i18nText('Nav.sidebarTitle')} mobileDescription={i18nText('Nav.sidebarDescription')} mobileCloseLabel={i18nText('Common.close')}>{body}</Sidebar>
  // On desktop the list is the first column inside the card; it folds to nothing and the rail stays.
  // R-37: the width moves on a spring; MotionConfig at the root turns it off for reduced motion.
  // While dragging the edge the width follows the pointer with no spring.
  return <motion.div ref={listRef} data-slot="bot-list" data-state={open ? 'expanded' : 'collapsed'} inert={!open} initial={false} animate={{ width: open ? width : 0 }} transition={instant ? { duration: 0 } : SPRING_SIDEBAR} className={cn('relative hidden shrink-0 overflow-hidden md:block', open ? 'border-r' : 'border-r-0', dragging && 'select-none')}>
    <Sidebar collapsible="none" className="w-[var(--bot-list-width,16rem)] bg-transparent">{body}</Sidebar>
    {/* Comma's edge strip with a hairline on hover: drag it or use the arrow keys to resize the list, double-click it to reset, click it to fold the list. */}
    <ResizeHandle resize={resize} label={i18nText('Nav.resizeList')} title={i18nText('Nav.collapseList')} edge="end" onClick={onEdgeClick} />
  </motion.div>
}
