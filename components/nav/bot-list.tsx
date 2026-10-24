'use client'

import { useEffect, useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { PanelLeft, Plus } from 'lucide-react'
import { getCoordinatorChat, type CoordinatorChat } from '@/app/actions/coordinator'
import type { BotView } from '@/app/actions/bots'
import type { Thread } from '@/app/actions/task-runs'
import { MikkaMark } from '@/components/brand/mikka-mark'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarRail, useSidebar } from '@/components/ui/sidebar'
import { WorkspaceMenu } from '@/components/workspace-menu'
import { cn } from '@/lib/utils'
import { sessionPreview, type SavedAgentSession } from '@/lib/agent-history'
import { RAIL_ITEMS, type RailDestination } from './icon-rail'
import { LetterAvatar } from './letter-avatar'
import { BotAvatar, type BotMood } from './bot-avatar'

/**
 * What the center column shows: the Coordinator, a bot's chat, or an older
 * chat that has no bot (reachable from ⌘K only; `sessionId: null` is a new one).
 */
export type ChatTarget = { kind: 'coordinator' } | { kind: 'bot'; botId: string } | { kind: 'agent'; sessionId: string | null }

type ListProps = {
  bots: BotView[]
  threads: Thread[]
  sessions: SavedAgentSession[]
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

/** A bot's mood from its threads: waiting on you, then working, then a failed last run, else idle. */
function botMood(threads: Thread[], botId: string): BotMood {
  const own = threads.filter(thread => thread.botId === botId)
  if (own.some(thread => thread.status === 'waiting_input')) return 'notify'
  if (own.some(thread => ['queued', 'preparing', 'running', 'finishing'].includes(thread.status))) return 'thinking'
  // Threads arrive newest first: a failure stays on its face until the next run.
  return own[0]?.status === 'failed' ? 'exclaim' : 'idle'
}

/** A Coordinator reply as one plain line: citations become their labels. */
function coordinatorLine(text: string) {
  return sessionPreview(text.replace(/\[\[(?:issue|run):[0-9a-f-]{36}\]\]/gi, '').replace(/\[([^\]\n]+)\]\([^)]+\)/g, '$1'), null)
}

function Row({ name, preview, avatar, current, unread, onClick }: { name: string; preview: ReactNode; avatar: ReactNode; current: boolean; unread: boolean; onClick: () => void }) {
  return <SidebarMenuItem><SidebarMenuButton size="lg" isActive={current} aria-current={current ? 'page' : undefined} aria-label={name} onClick={onClick} className="h-13 gap-2.5 rounded-xl px-2.5">
    {avatar}
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
export function BotList({ bots, threads, sessions, active, onOpen, onNewBot, rail, onRail, user, onSettings, onSignOut, signingOut, onBeforeChange }: ListProps) {
  const i18nText = useTranslations()
  const { toggleSidebar, setOpenMobile, open, openMobile, isMobile } = useSidebar()
  const { data: coordinator } = useSWR<CoordinatorChat>('coordinator-chat', () => getCoordinatorChat(), { revalidateOnFocus: false })
  // Each bot's latest chat gives its row the preview line and its place in the list.
  const latestChat = new Map<string, SavedAgentSession>()
  for (const session of sessions) {
    if (!session.botId) continue
    const current = latestChat.get(session.botId)
    if (!current || session.updatedAt > current.updatedAt) latestChat.set(session.botId, session)
  }
  const ordered = [...bots].sort((a, b) => (latestChat.get(b.id)?.updatedAt ?? '').localeCompare(latestChat.get(a.id)?.updatedAt ?? '') || a.name.localeCompare(b.name))
  const lastReply = coordinator?.items.findLast(item => item.from !== 'event')
  const latest: Record<string, string> = {}
  for (const [botId, session] of latestChat) latest[botId] = session.updatedAt
  if (lastReply?.from === 'coordinator') latest.coordinator = lastReply.createdAt
  const activeId = active?.kind === 'coordinator' ? 'coordinator' : active?.kind === 'bot' ? active.botId : null
  const unread = useUnread(activeId, latest)
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
        <Row name={i18nText('Nav.coordinator')} current={active?.kind === 'coordinator'} unread={unread('coordinator')} onClick={() => choose({ kind: 'coordinator' })}
          avatar={<LetterAvatar name="Coordinator" tone="coordinator" />}
          preview={<><span className="shrink-0">{i18nText('Shell.pinned')}</span>{lastReply && <><span aria-hidden="true">·</span><span className="truncate">{coordinatorLine(lastReply.text)}</span></>}</>} />
        {ordered.map(bot => {
          const line = latestChat.get(bot.id)?.preview
          return <Row key={bot.id} name={bot.name} current={active?.kind === 'bot' && active.botId === bot.id} unread={unread(bot.id)} onClick={() => choose({ kind: 'bot', botId: bot.id })}
            avatar={<BotAvatar color={bot.color} shape={bot.shape} mood={botMood(threads, bot.id)} />}
            preview={line ? <span className="truncate">{line}</span> : null} />
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
  return <div data-slot="bot-list" data-state={open ? 'expanded' : 'collapsed'} inert={!open} className={cn('relative hidden shrink-0 overflow-hidden border-r transition-[width] duration-150 ease-out motion-reduce:transition-none md:block', open ? 'w-64' : 'w-0 border-r-0')}>
    <Sidebar collapsible="none" className="w-64 bg-transparent">{body}</Sidebar>
    {/* Comma's edge toggle: an invisible strip along the edge that shows a hairline on hover. */}
    <SidebarRail label={i18nText('Nav.sidebarRail')} title={i18nText('Nav.collapseList')} className="right-0 left-auto w-2 cursor-col-resize ltr:translate-x-0 rtl:translate-x-0 after:inset-y-3 after:start-auto after:right-0 after:w-px after:bg-border after:opacity-0 after:transition-opacity hover:after:opacity-100" />
  </div>
}
