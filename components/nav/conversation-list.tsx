'use client'

import { useEffect, useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { PanelLeft, Plus } from 'lucide-react'
import { getCoordinatorChat, type CoordinatorChat } from '@/app/actions/coordinator'
import { MikkaMark } from '@/components/brand/mikka-mark'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarRail, useSidebar } from '@/components/ui/sidebar'
import { WorkspaceMenu } from '@/components/workspace-menu'
import { cn } from '@/lib/utils'
import { sessionPreview } from '@/lib/agent-history'
import { RAIL_ITEMS, type RailDestination } from './icon-rail'
import { LetterAvatar } from './letter-avatar'

/** Current Bot chat or a read-only historical chat. `agent` is a legacy URL discriminator only. */
export type Conversation = { kind: 'coordinator' } | { kind: 'agent'; sessionId: string | null } | { kind: 'group'; id: string; title: string; workspaceId: string }

type ListProps = {
  active: Conversation | null
  onOpen: (conversation: Conversation) => void
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
 * remembers when it last showed a conversation; anything newer is unread.
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

/** A Coordinator reply as one plain line: citations become their labels. */
function coordinatorLine(text: string) {
  return sessionPreview(text.replace(/\[\[(?:issue|run):[0-9a-f-]{36}\]\]/gi, '').replace(/\[([^\]\n]+)\]\([^)]+\)/g, '$1'), null)
}

/** Green while the conversation's bot is working, orange while it waits on you; otherwise no dot. */
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
 * The conversation list beside the icon rail (Figma 48:3): Coordinator first, then agent sessions by latest activity, each a name over a one-line
 * preview. It collapses off canvas; the rail stays.
 */
export function ConversationList({ active, onOpen, rail, onRail, user, onSettings, onSignOut, signingOut, onBeforeChange }: ListProps) {
  const i18nText = useTranslations()
  const { toggleSidebar, setOpenMobile, open, openMobile, isMobile } = useSidebar()
  const { data: coordinator } = useSWR<CoordinatorChat>('coordinator-chat', () => getCoordinatorChat(), { revalidateOnFocus: false })
  const lastReply = coordinator?.items.findLast(item => item.from !== 'event')
  const latest: Record<string, string> = {}
  if (lastReply?.from === 'coordinator') latest.coordinator = lastReply.createdAt
  const activeId = active?.kind === 'coordinator' ? 'coordinator' : active?.kind === 'agent' ? active.sessionId : null
  const unread = useUnread(activeId, latest)
  function choose(conversation: Conversation) { onOpen(conversation); setOpenMobile(false) }
  const body = <>
    <SidebarHeader className="px-3 pt-3 pb-1">
      <div className="flex h-8 items-center gap-1 pl-1">
        <MikkaMark />
        <span className="sr-only">Mikka</span>
        <div className="ml-auto flex items-center gap-1">
          {!isMobile && <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={i18nText('Nav.collapseList')} aria-expanded={isMobile ? openMobile : open} onClick={toggleSidebar} />}><PanelLeft data-icon="inline-start" /></TooltipTrigger><TooltipContent side="bottom">{i18nText('Nav.collapseList')}</TooltipContent></Tooltip>}
          <Tooltip><TooltipTrigger render={<Button variant="secondary" size="icon-sm" aria-label={i18nText('Nav.openBotChat')} onClick={() => choose({ kind: 'coordinator' })} />}><Plus data-icon="inline-start" /></TooltipTrigger><TooltipContent side="bottom">{i18nText('Nav.openBotChat')}</TooltipContent></Tooltip>
        </div>
      </div>
    </SidebarHeader>
    <SidebarContent>
      <SidebarGroup className="px-2 pt-1"><SidebarMenu aria-label={i18nText('Nav.conversations')} className="gap-0.5">
        <Row name={i18nText('Nav.coordinator')} label={coordinator?.working ? i18nText('Nav.coordinatorWorking') : i18nText('Nav.coordinator')} current={active?.kind === 'coordinator'} unread={unread('coordinator')} onClick={() => choose({ kind: 'coordinator' })}
          avatar={<LetterAvatar name="Coordinator" tone="coordinator" />}
          status={coordinator?.working ? 'working' : undefined}
          preview={lastReply ? <span className="truncate">{coordinatorLine(lastReply.text)}</span> : null} />

      </SidebarMenu></SidebarGroup>
    </SidebarContent>
    {/* Phones have no rail; its destinations and the account menu move here. */}
    {isMobile && <SidebarFooter>
      <SidebarMenu>{RAIL_ITEMS.filter(item => item.id !== 'conversations').map(item => <SidebarMenuItem key={item.id}><SidebarMenuButton isActive={rail === item.id} onClick={() => { onRail(item.id); setOpenMobile(false) }}><item.icon /><span>{i18nText(item.label)}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
      <SidebarMenu><SidebarMenuItem><WorkspaceMenu user={user} onSettings={onSettings} onSignOut={onSignOut} signingOut={signingOut} onBeforeChange={onBeforeChange} /></SidebarMenuItem></SidebarMenu>
    </SidebarFooter>}
  </>
  if (isMobile) return <Sidebar collapsible="offcanvas" mobileTitle={i18nText('Nav.sidebarTitle')} mobileDescription={i18nText('Nav.sidebarDescription')} mobileCloseLabel={i18nText('Common.close')}>{body}</Sidebar>
  // On desktop the list is the first column inside the card; it folds to nothing and the rail stays.
  return <div data-slot="conversation-list" data-state={open ? 'expanded' : 'collapsed'} inert={!open} className={cn('relative hidden shrink-0 overflow-hidden border-r transition-[width] duration-150 ease-out motion-reduce:transition-none md:block', open ? 'w-64' : 'w-0 border-r-0')}>
    <Sidebar collapsible="none" className="w-64 bg-transparent">{body}</Sidebar>
    {/* Comma's edge toggle: an invisible strip along the edge that shows a hairline on hover. */}
    <SidebarRail label={i18nText('Nav.sidebarRail')} title={i18nText('Nav.collapseList')} className="right-0 left-auto w-2 cursor-col-resize ltr:translate-x-0 rtl:translate-x-0 after:inset-y-3 after:start-auto after:right-0 after:w-px after:bg-border after:opacity-0 after:transition-opacity hover:after:opacity-100" />
  </div>
}
