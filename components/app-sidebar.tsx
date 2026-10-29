'use client'

import * as React from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { listTeams } from '@/app/actions/teams'
import { Box, ChevronDown, CircleHelp, Ellipsis, House, Inbox, Layers, Puzzle, Scan, Search, Send, SquarePen, SquareUserRound, Workflow } from 'lucide-react'
import { WorkspaceMenu } from '@/components/workspace-menu'
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubItem, SidebarMenuSubButton, SidebarRail, useSidebar } from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { ShortcutKeys } from '@/components/shortcut-keys'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import type { WorkspaceSection } from '@/components/workspace/workspace-navigation'

export function AppSidebar({ user, section, teamId, onTeamNavigate, onNavigate, onSearch, onCreate, onSettings, onSignOut, signingOut, onBeforeChange, ...props }: React.ComponentProps<typeof Sidebar> & {
  user: { name: string; email: string; image?: string | null }
  section: WorkspaceSection
  onNavigate: (section: WorkspaceSection) => boolean
  onSearch: () => void
  onCreate: () => void
  onSettings: (href?: string) => void
  onSignOut: () => void
  signingOut: boolean
  onBeforeChange?: (action: () => Promise<void>) => void
  teamId: string | null
  onTeamNavigate: (teamId: string, section: WorkspaceSection) => boolean
}) {
  const i18nText = useTranslations();
  const { data: teams = [], error: teamsError, mutate: refreshTeams } = useSWR('teams', listTeams)
  const { setOpenMobile, open, openMobile, isMobile } = useSidebar()
  function navigate(next: WorkspaceSection) { if (onNavigate(next)) setOpenMobile(false) }
  const personal = [{ id: 'inbox', title: i18nText("Overview.sections.inbox"), icon: Inbox }, { id: 'my-issues', title: i18nText("Overview.sections.myIssues"), icon: Scan }] as const
  const teamItems = [{ id: 'team-home', title: i18nText("Nav.home"), icon: House }, { id: 'team-issues', title: i18nText("Projects.detail.issues"), icon: Layers }, { id: 'team-projects', title: i18nText("Projects.title"), icon: Box }] as const
  return <Sidebar variant="inset" mobileTitle={i18nText("Nav.sidebarTitle")} mobileDescription={i18nText("Nav.sidebarDescription")} mobileCloseLabel={i18nText("Common.close")} {...props}>
    <SidebarHeader className="pb-4">
      <div className="flex items-center gap-1">
        <SidebarMenu className="min-w-0 flex-1"><SidebarMenuItem>
          <WorkspaceMenu user={user} onSettings={onSettings} onSignOut={onSignOut} signingOut={signingOut} onBeforeChange={onBeforeChange} />
        </SidebarMenuItem></SidebarMenu>
        <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={i18nText("Workspace.search.title")} aria-keyshortcuts="Control+k Meta+k" onClick={() => { setOpenMobile(false); onSearch() }} />}><Search data-icon="inline-start" /></TooltipTrigger><TooltipContent side="bottom">{i18nText("Workspace.search.title")}<ShortcutKeys keys={['mod', 'K']} /></TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger render={<Button variant="secondary" size="icon-sm" aria-label={i18nText("Projects.detail.newIssue")} aria-keyshortcuts="c" onClick={() => { setOpenMobile(false); onCreate() }} />}><SquarePen data-icon="inline-start" /></TooltipTrigger><TooltipContent side="bottom">{i18nText("Projects.detail.newIssue")}<Kbd>C</Kbd></TooltipContent></Tooltip>
      </div>
    </SidebarHeader>
    <SidebarContent className="gap-5">
      <SidebarGroup className="pt-0"><SidebarMenu>{personal.map(item => <SidebarMenuItem key={item.id}><SidebarMenuButton tooltip={item.title} isActive={section === item.id} onClick={() => navigate(item.id)}><item.icon /><span>{item.title}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></SidebarGroup>
      <SidebarGroup className="pt-0"><SidebarMenu>
        <SidebarMenuItem><SidebarMenuButton tooltip={i18nText("Nav.agent")} isActive={section === 'agent'} onClick={() => navigate('agent')}><Send /><span>{i18nText("Nav.agent")}</span></SidebarMenuButton></SidebarMenuItem>
        <SidebarMenuItem><SidebarMenuButton tooltip={i18nText("Nav.coordinator")} isActive={section === 'coordinator'} onClick={() => navigate('coordinator')}><Workflow /><span>{i18nText("Nav.coordinator")}</span></SidebarMenuButton></SidebarMenuItem>
      </SidebarMenu></SidebarGroup>
      <Collapsible defaultOpen className="group/workspace"><SidebarGroup>
        <SidebarGroupLabel render={<CollapsibleTrigger />} className="mb-1 cursor-pointer">{i18nText("Settings.sections.workspace.title")}<ChevronDown className="ml-1 transition-transform group-data-closed/workspace:-rotate-90" /></SidebarGroupLabel>
        <CollapsibleContent><SidebarMenu>
          <SidebarMenuItem><SidebarMenuButton isActive={section === 'projects'} onClick={() => navigate('projects')}><Box /><span>{i18nText("Projects.title")}</span></SidebarMenuButton></SidebarMenuItem>
          <SidebarMenuItem><SidebarMenuButton isActive={section === 'all-issues'} onClick={() => navigate('all-issues')}><Layers /><span>{i18nText("Projects.detail.issues")}</span></SidebarMenuButton></SidebarMenuItem>
          <SidebarMenuItem><SidebarMenuButton isActive={section === 'views'} onClick={() => navigate('views')}><Layers /><span>{i18nText("Overview.sections.views")}</span></SidebarMenuButton></SidebarMenuItem>
          <SidebarMenuItem><DropdownMenu><DropdownMenuTrigger render={<SidebarMenuButton />}><Ellipsis /><span>{i18nText("Nav.more")}</span></DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuGroup><DropdownMenuItem onClick={() => navigate('all-issues')}><Layers />{i18nText("Overview.sections.allIssues")}</DropdownMenuItem><DropdownMenuItem render={<a href="https://linear.app/docs/projects" target="_blank" rel="noreferrer" />}><CircleHelp />{i18nText("FeatureCopy.c_ab868d77")}</DropdownMenuItem></DropdownMenuGroup></DropdownMenuContent></DropdownMenu></SidebarMenuItem>
        </SidebarMenu></CollapsibleContent>
      </SidebarGroup></Collapsible>
      <Collapsible defaultOpen className="group/teams"><SidebarGroup>
        <SidebarGroupLabel render={<CollapsibleTrigger />} className="mb-1 cursor-pointer">{i18nText("Nav.yourTeams")}<ChevronDown className="ml-1 transition-transform group-data-closed/teams:-rotate-90" /></SidebarGroupLabel>
        <CollapsibleContent><SidebarMenu>{teams.filter(team => team.role).map(team => <SidebarMenuItem key={team.id}>
          <Collapsible defaultOpen className="group/team"><CollapsibleTrigger render={<SidebarMenuButton aria-label={i18nText("FeatureCopy.c_3e984369", { value0: (team.name) })} />}><SquareUserRound className="text-info-foreground" /><span>{team.name}</span><ChevronDown className="ml-auto transition-transform group-data-closed/team:-rotate-90" /></CollapsibleTrigger>
            <CollapsibleContent><SidebarMenuSub className="mx-0 ml-4 border-0 px-0">{teamItems.map(item => <SidebarMenuSubItem key={item.id}><SidebarMenuSubButton render={<Button variant="ghost" />} className="h-8 w-full justify-start" isActive={teamId === team.id && section === item.id} onClick={() => { if (onTeamNavigate(team.id, item.id)) setOpenMobile(false) }}><item.icon /><span>{item.title}</span></SidebarMenuSubButton></SidebarMenuSubItem>)}</SidebarMenuSub></CollapsibleContent>
          </Collapsible>
        </SidebarMenuItem>)}{teamsError && <SidebarMenuItem><SidebarMenuButton onClick={() => void refreshTeams()}>{i18nText("FeatureCopy.c_c401eee8")}</SidebarMenuButton></SidebarMenuItem>}</SidebarMenu></CollapsibleContent>
      </SidebarGroup></Collapsible>
    </SidebarContent>
  <SidebarFooter>
    <SidebarMenu>
      <SidebarMenuItem><SidebarMenuButton isActive={section === 'plugins'} aria-current={section === 'plugins' ? 'page' : undefined} onClick={() => navigate('plugins')} tooltip={i18nText("Nav.plugins")}><Puzzle /><span>{i18nText("Nav.plugins")}</span></SidebarMenuButton></SidebarMenuItem>
    </SidebarMenu>
  </SidebarFooter>
  <SidebarRail aria-label={i18nText("Nav.sidebarRail")} title={i18nText("Workspace.toggleSidebar")} aria-expanded={isMobile ? openMobile : open} />
  </Sidebar>
}
