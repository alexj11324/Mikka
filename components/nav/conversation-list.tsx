'use client'

import { useTranslations } from 'next-intl'
import { MessageSquare, PanelLeftClose, Pin, SquarePen, Workflow } from 'lucide-react'
import { MikkaMark } from '@/components/brand/mikka-mark'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarRail, useSidebar } from '@/components/ui/sidebar'
import { WorkspaceMenu } from '@/components/workspace-menu'
import type { SavedAgentSession } from '@/lib/agent-history'
import { RAIL_ITEMS, type RailDestination } from './icon-rail'

/** What the center column shows: the Coordinator, or one agent session. */
export type Conversation = { kind: 'coordinator' } | { kind: 'agent'; sessionId: string | null }

type ListProps = {
  sessions: SavedAgentSession[]
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

/**
 * The conversation list beside the icon rail: Coordinator pinned on top, then
 * agent sessions by latest activity. It collapses off canvas; the rail stays.
 */
export function ConversationList({ sessions, active, onOpen, rail, onRail, user, onSettings, onSignOut, signingOut, onBeforeChange }: ListProps) {
  const i18nText = useTranslations()
  const { toggleSidebar, setOpenMobile, open, openMobile, isMobile } = useSidebar()
  const recent = [...sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  function choose(conversation: Conversation) { onOpen(conversation); setOpenMobile(false) }
  return <Sidebar collapsible="offcanvas" mobileTitle={i18nText('Nav.sidebarTitle')} mobileDescription={i18nText('Nav.sidebarDescription')} mobileCloseLabel={i18nText('Common.close')}
    className="data-[side=left]:left-14 data-[side=left]:group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)]">
    <SidebarHeader>
      <div className="flex h-9 items-center gap-1 pl-2">
        <MikkaMark />
        <span className="sr-only">Mikka</span>
        <div className="ml-auto flex items-center gap-1">
          {!isMobile && <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={i18nText('Nav.collapseList')} aria-expanded={isMobile ? openMobile : open} onClick={toggleSidebar} />}><PanelLeftClose data-icon="inline-start" /></TooltipTrigger><TooltipContent side="bottom">{i18nText('Nav.collapseList')}</TooltipContent></Tooltip>}
          <Tooltip><TooltipTrigger render={<Button variant="secondary" size="icon-sm" aria-label={i18nText('Nav.newConversation')} onClick={() => choose({ kind: 'agent', sessionId: null })} />}><SquarePen data-icon="inline-start" /></TooltipTrigger><TooltipContent side="bottom">{i18nText('Nav.newConversation')}</TooltipContent></Tooltip>
        </div>
      </div>
    </SidebarHeader>
    <SidebarContent>
      <SidebarGroup className="pt-0"><SidebarMenu aria-label={i18nText('Nav.conversations')}>
        <SidebarMenuItem><SidebarMenuButton size="lg" isActive={active?.kind === 'coordinator'} aria-current={active?.kind === 'coordinator' ? 'page' : undefined} onClick={() => choose({ kind: 'coordinator' })}>
          <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sidebar-primary text-sidebar-primary-foreground"><Workflow className="size-4" /></span>
          <span className="flex-1 truncate font-medium">{i18nText('Nav.coordinator')}</span>
          <Pin aria-label={i18nText('Nav.pinned')} className="text-muted-foreground" />
        </SidebarMenuButton></SidebarMenuItem>
        {recent.map(session => {
          const current = active?.kind === 'agent' && active.sessionId === session.id
          return <SidebarMenuItem key={session.id}><SidebarMenuButton size="lg" isActive={current} aria-current={current ? 'page' : undefined} onClick={() => choose({ kind: 'agent', sessionId: session.id })}>
            <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-sidebar-accent-foreground"><MessageSquare className="size-4" /></span>
            <span className="flex-1 truncate">{session.title || i18nText('Nav.untitledConversation')}</span>
          </SidebarMenuButton></SidebarMenuItem>
        })}
      </SidebarMenu></SidebarGroup>
    </SidebarContent>
    {/* Phones have no rail; its destinations and the account menu move here. */}
    {isMobile && <SidebarFooter>
      <SidebarMenu>{RAIL_ITEMS.filter(item => item.id !== 'conversations').map(item => <SidebarMenuItem key={item.id}><SidebarMenuButton isActive={rail === item.id} onClick={() => { onRail(item.id); setOpenMobile(false) }}><item.icon /><span>{i18nText(item.label)}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
      <SidebarMenu><SidebarMenuItem><WorkspaceMenu user={user} onSettings={onSettings} onSignOut={onSignOut} signingOut={signingOut} onBeforeChange={onBeforeChange} /></SidebarMenuItem></SidebarMenu>
    </SidebarFooter>}
    <SidebarRail aria-label={i18nText('Nav.sidebarRail')} title={i18nText('Workspace.toggleSidebar')} aria-expanded={isMobile ? openMobile : open} />
  </Sidebar>
}
