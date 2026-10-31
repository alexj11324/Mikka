'use client'

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import useSWR from 'swr'
import { motion } from 'motion/react'
import { useTranslations } from 'next-intl'
import { PanelLeft, Plus } from 'lucide-react'
import { botChatSummaries, getCoordinatorChat, type CoordinatorChat } from '@/app/actions/coordinator'
import type { BotView } from '@/app/actions/bots'
import type { Thread } from '@/app/actions/task-runs'
import { MikkaMark } from '@/components/brand/mikka-mark'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarRail, useSidebar } from '@/components/ui/sidebar'
import { WorkspaceMenu } from '@/components/workspace-menu'
import { cn } from '@/lib/utils'
import { SPRING_SIDEBAR } from '@/lib/ease'
import { markdownLine, sessionPreview } from '@/lib/agent-history'
import { RAIL_ITEMS, type RailDestination } from './icon-rail'
import { BotAvatar, CoordinatorAvatar, type BotMood } from './bot-avatar'

/**
 * What the center column shows: the Coordinator, a bot's chat (both on the
 * Coordinator harness), or a read-only older chat (reachable from ⌘K only).
 */
export type ChatTarget = { kind: 'coordinator' } | { kind: 'bot'; botId: string } | { kind: 'agent'; sessionId: string | null } | { kind: 'group'; id: string; title: string; workspaceId: string }

type ListProps = {
  bots: BotView[]
  threads: Thread[]
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
}

const WIDTH_KEY = 'mikka:bot-list-width'
const LIST_WIDTH = { min: 208, max: 400, initial: 256 }
const clampWidth = (value: number) => Math.round(Math.min(LIST_WIDTH.max, Math.max(LIST_WIDTH.min, value)))

/**
 * Dragging the list's edge sets its width, as in Linear's sidebar; the width is
 * remembered on this device. A click without a drag still folds the list.
 */
function useListWidth() {
  const [width, setWidth] = useState(LIST_WIDTH.initial)
  const [dragging, setDragging] = useState(false)
  // The remembered width is applied on load without a spring.
  const [restored, setRestored] = useState(false)
  const moved = useRef(false)
  useEffect(() => {
    try {
      const stored = Number(window.localStorage.getItem(WIDTH_KEY))
      if (stored) setWidth(clampWidth(stored))
    } catch { /* storage unavailable */ }
    const frame = requestAnimationFrame(() => setRestored(true))
    return () => cancelAnimationFrame(frame)
  }, [])
  function onPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return
    const strip = event.currentTarget, startX = event.clientX, startWidth = width
    const direction = getComputedStyle(strip).direction === 'rtl' ? -1 : 1
    let latest = startWidth
    moved.current = false
    strip.setPointerCapture(event.pointerId)
    const move = (next: PointerEvent) => {
      const delta = (next.clientX - startX) * direction
      // A few pixels of jitter is still a click.
      if (!moved.current && Math.abs(delta) < 3) return
      if (!moved.current) { moved.current = true; setDragging(true) }
      latest = clampWidth(startWidth + delta)
      setWidth(latest)
    }
    const end = () => {
      strip.removeEventListener('pointermove', move)
      strip.removeEventListener('pointerup', end)
      strip.removeEventListener('pointercancel', end)
      if (!moved.current) return
      setDragging(false)
      try { window.localStorage.setItem(WIDTH_KEY, String(latest)) } catch { /* storage unavailable */ }
    }
    strip.addEventListener('pointermove', move)
    strip.addEventListener('pointerup', end)
    strip.addEventListener('pointercancel', end)
  }
  /** True once for the click that ends a drag, so that click does not fold the list. */
  function endedDrag() {
    const was = moved.current
    moved.current = false
    return was
  }
  return { width, dragging, instant: dragging || !restored, onPointerDown, endedDrag }
}

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

/** A bot's mood from its chat and threads: waiting on you, then working, then a failed last run, else idle. */
function botMood(threads: Thread[], botId: string, chatting: boolean): BotMood {
  const own = threads.filter(thread => thread.botId === botId)
  if (own.some(thread => thread.status === 'waiting_input')) return 'notify'
  if (chatting || own.some(thread => ['queued', 'preparing', 'running', 'finishing'].includes(thread.status))) return 'thinking'
  // Threads arrive newest first: a failure stays on its face until the next run.
  return own[0]?.status === 'failed' ? 'exclaim' : 'idle'
}

/** A Coordinator reply as one plain line: citations become their labels. */
function coordinatorLine(text: string) {
  return sessionPreview(markdownLine(text), null)
}

/** Green while the bot is working, orange while it waits on you; otherwise no dot. */
type RowStatus = 'working' | 'waiting'

function Row({ name, preview, avatar, status, current, unread, onClick, label }: { name: string; preview: ReactNode; avatar: ReactNode; status?: RowStatus; current: boolean; unread: boolean; onClick: () => void; label: string }) {
  return <SidebarMenuItem><SidebarMenuButton size="lg" isActive={current} aria-current={current ? 'page' : undefined} aria-label={label} onClick={onClick} className="h-13 gap-2.5 rounded-xl px-2.5">
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
 * on top, then one row per bot with its blob, its name and the latest line
 * of its chat, most recent first. Threads (the work a bot does) live in the
 * right column, never here. It collapses off canvas; the rail stays.
 */
export function BotList({ bots, threads, active, onOpen, onNewBot, rail, onRail, user, onSettings, onSignOut, signingOut, onBeforeChange }: ListProps) {
  const i18nText = useTranslations()
  const { toggleSidebar, setOpenMobile, open, openMobile, isMobile } = useSidebar()
  const { data: coordinator } = useSWR<CoordinatorChat>('coordinator-chat', () => getCoordinatorChat(), { revalidateOnFocus: false })
  // Each bot's latest line gives its row the preview and its place in the list.
  const { data: chats = {} } = useSWR('bot-chats', () => botChatSummaries(), { refreshInterval: 15000, revalidateOnFocus: false })
  const ordered = [...bots].sort((a, b) => (chats[b.id]?.at ?? '').localeCompare(chats[a.id]?.at ?? '') || a.name.localeCompare(b.name))
  const lastReply = coordinator?.items.findLast(item => item.from !== 'event')
  const latest: Record<string, string> = {}
  for (const [botId, chat] of Object.entries(chats)) if (chat.at) latest[botId] = chat.at
  if (lastReply?.from === 'coordinator') latest.coordinator = lastReply.createdAt
  const activeId = active?.kind === 'coordinator' ? 'coordinator' : active?.kind === 'bot' ? active.botId : null
  const unread = useUnread(activeId, latest)
  const { width, dragging, instant, onPointerDown, endedDrag } = useListWidth()
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
          preview={lastReply ? <span className="truncate">{coordinatorLine(lastReply.text)}</span> : null} />
        {ordered.map(bot => {
          const chat = chats[bot.id]
          const mood = botMood(threads, bot.id, chat?.working ?? false)
          const status: RowStatus | undefined = mood === 'notify' ? 'waiting' : mood === 'thinking' ? 'working' : undefined
          return <Row key={bot.id} name={bot.name} label={bot.name} current={active?.kind === 'bot' && active.botId === bot.id} unread={unread(bot.id)} onClick={() => choose({ kind: 'bot', botId: bot.id })}
            avatar={<BotAvatar color={bot.color} shape={bot.shape} mood={mood} />} status={status}
            preview={chat?.line ? <span className="truncate">{coordinatorLine(chat.line)}</span> : null} />
        })}
      </SidebarMenu></SidebarGroup>
    </SidebarContent>
    {/* Phones have no rail; its destinations and the account menu move here. */}
    {isMobile && <SidebarFooter>
      <SidebarMenu>{RAIL_ITEMS.filter(item => item.id !== 'chats').map(item => <SidebarMenuItem key={item.id}><SidebarMenuButton isActive={rail === item.id} onClick={() => { onRail(item.id); setOpenMobile(false) }}><item.icon /><span>{i18nText(item.label)}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
      <SidebarMenu><SidebarMenuItem><WorkspaceMenu user={user} onSettings={onSettings} onSignOut={onSignOut} signingOut={signingOut} onBeforeChange={onBeforeChange} /></SidebarMenuItem></SidebarMenu>
    </SidebarFooter>}
  </>
  if (isMobile) return <Sidebar collapsible="offcanvas" mobileTitle={i18nText('Nav.sidebarTitle')} mobileDescription={i18nText('Nav.sidebarDescription')} mobileCloseLabel={i18nText('Common.close')}>{body}</Sidebar>
  // On desktop the list is the first column inside the card; it folds to nothing and the rail stays.
  // R-37: the width moves on a spring; MotionConfig at the root turns it off for reduced motion.
  // While dragging the edge the width follows the pointer with no spring.
  return <motion.div ref={listRef} data-slot="bot-list" data-state={open ? 'expanded' : 'collapsed'} inert={!open} initial={false} animate={{ width: open ? width : 0 }} transition={instant ? { duration: 0 } : SPRING_SIDEBAR} className={cn('relative hidden shrink-0 overflow-hidden md:block', open ? 'border-r' : 'border-r-0', dragging && 'select-none')}>
    <Sidebar collapsible="none" className="w-[var(--bot-list-width,16rem)] bg-transparent">{body}</Sidebar>
    {/* Comma's edge strip with a hairline on hover: drag it to resize the list, click it to fold the list. */}
    <SidebarRail label={i18nText('Nav.sidebarRail')} title={i18nText('Nav.collapseList')} onPointerDown={onPointerDown} onClick={() => { if (!endedDrag()) toggleSidebar() }} className="right-0 left-auto w-2 cursor-col-resize ltr:translate-x-0 rtl:translate-x-0 after:inset-y-3 after:start-auto after:right-0 after:w-px after:bg-border after:opacity-0 after:transition-opacity hover:after:opacity-100" />
  </motion.div>
}
