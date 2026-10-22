'use client'

import * as React from 'react'
import { Link } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
import { Box, ChevronDown, CircleHelp, Ellipsis, House, Inbox, Layers, MonitorSmartphone, Scan, Search, Send, SquarePen, SquareUserRound, Users, Workflow } from 'lucide-react'
import { NavUser } from '@/components/nav-user'
import { WorkspaceSwitcher } from '@/components/workspace/workspace-switcher'
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubItem, SidebarMenuSubButton, SidebarRail, useSidebar } from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { WORKSPACE_NAME } from '@/components/workspace/issue-properties'
import type { WorkspaceSection } from '@/components/workspace/workspace-navigation'

export function AppSidebar({ user, section, onNavigate, onSearch, onCreate, onSettings, onSignOut, signingOut, onWorkspaceChange, ...props }: React.ComponentProps<typeof Sidebar> & {
  user: { name: string; email: string; image?: string | null }
  section: WorkspaceSection
  onNavigate: (section: WorkspaceSection) => boolean
  onSearch: () => void
  onCreate: () => void
  onSettings: (section?: 'preferences' | 'members', invite?: boolean) => void
  onSignOut: () => void
  signingOut: boolean
  onWorkspaceChange: () => Promise<boolean>
}) {
  const { setOpenMobile, open, openMobile, isMobile } = useSidebar()
  const t = useTranslations('Nav')
  const commonT = useTranslations('Common')
  function navigate(next: WorkspaceSection) { if (onNavigate(next)) setOpenMobile(false) }
  const personal = [{ id: 'inbox', title: t('inbox'), icon: Inbox }, { id: 'my-issues', title: t('myTasks'), icon: Scan }, { id: 'agent', title: t('agent'), icon: Send }, { id: 'coordinator', title: t('coordinator'), icon: Workflow }] as const
  const teamItems = [{ id: 'team-home', title: t('home'), icon: House }, { id: 'team-issues', title: t('tasks'), icon: Layers }, { id: 'team-projects', title: t('projects'), icon: Box }] as const
  return <Sidebar variant="inset" mobileTitle={t('sidebarTitle')} mobileDescription={t('sidebarDescription')} mobileCloseLabel={commonT('close')} {...props}>
    <SidebarHeader className="pb-4">
      <div className="flex items-center gap-1">
        <SidebarMenu className="min-w-0 flex-1"><SidebarMenuItem>
          <WorkspaceSwitcher userKey={user.email} canLeave={onWorkspaceChange} />
        </SidebarMenuItem></SidebarMenu>
        <Button variant="ghost" size="icon-sm" aria-label={t('search')} title={t('searchTooltip')} onClick={() => { setOpenMobile(false); onSearch() }}><Search data-icon="inline-start" /></Button>
        <Button variant="secondary" size="icon-sm" aria-label={t('newTask')} title={t('newTaskHint')} onClick={() => { setOpenMobile(false); onCreate() }}><SquarePen data-icon="inline-start" /></Button>
      </div>
    </SidebarHeader>
    <SidebarContent className="gap-5">
      <SidebarGroup className="pt-0"><SidebarMenu>{personal.map(item => <SidebarMenuItem key={item.id}><SidebarMenuButton tooltip={item.title} isActive={section === item.id} onClick={() => navigate(item.id)}><item.icon /><span>{item.title}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></SidebarGroup>
      <Collapsible defaultOpen className="group/workspace"><SidebarGroup>
        <SidebarGroupLabel render={<CollapsibleTrigger />} className="mb-1 cursor-pointer">{t('workspace')}<ChevronDown className="ml-1 transition-transform group-data-closed/workspace:-rotate-90" /></SidebarGroupLabel>
        <CollapsibleContent><SidebarMenu>
          <SidebarMenuItem><SidebarMenuButton isActive={section === 'projects'} onClick={() => navigate('projects')}><Box /><span>{t('projects')}</span></SidebarMenuButton></SidebarMenuItem>
          <SidebarMenuItem><SidebarMenuButton isActive={section === 'views'} onClick={() => navigate('views')}><Layers /><span>{t('views')}</span></SidebarMenuButton></SidebarMenuItem>
          <SidebarMenuItem><DropdownMenu><DropdownMenuTrigger render={<SidebarMenuButton />}><Ellipsis /><span>{t('more')}</span></DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuGroup><DropdownMenuItem onClick={() => navigate('all-issues')}><Layers />{t('allIssues')}</DropdownMenuItem><DropdownMenuItem render={<a href="https://linear.app/docs/projects" target="_blank" rel="noreferrer" />}><CircleHelp />{t('projectGuide')}</DropdownMenuItem></DropdownMenuGroup></DropdownMenuContent></DropdownMenu></SidebarMenuItem>
        </SidebarMenu></CollapsibleContent>
      </SidebarGroup></Collapsible>
      <Collapsible defaultOpen className="group/teams"><SidebarGroup>
        <SidebarGroupLabel render={<CollapsibleTrigger />} className="mb-1 cursor-pointer">{t('yourTeams')}<ChevronDown className="ml-1 transition-transform group-data-closed/teams:-rotate-90" /></SidebarGroupLabel>
        <CollapsibleContent><SidebarMenu><SidebarMenuItem>
          <Collapsible defaultOpen className="group/team"><CollapsibleTrigger render={<SidebarMenuButton aria-label={t('toggleTeam', { name: WORKSPACE_NAME })} />}><SquareUserRound className="text-info-foreground" /><span>{WORKSPACE_NAME}</span><ChevronDown className="ml-auto transition-transform group-data-closed/team:-rotate-90" /></CollapsibleTrigger>
            <CollapsibleContent><SidebarMenuSub className="mx-0 ml-4 border-0 px-0">{teamItems.map(item => <SidebarMenuSubItem key={item.id}><SidebarMenuSubButton render={<Button variant="ghost" />} isActive={section === item.id} onClick={() => navigate(item.id)}><item.icon /><span>{item.title}</span></SidebarMenuSubButton></SidebarMenuSubItem>)}</SidebarMenuSub></CollapsibleContent>
          </Collapsible>
        </SidebarMenuItem></SidebarMenu></CollapsibleContent>
      </SidebarGroup></Collapsible>
    </SidebarContent>
    <SidebarFooter>
      <SidebarMenu>
        <SidebarMenuItem><SidebarMenuButton onClick={() => { setOpenMobile(false); onSettings('members') }} tooltip={t('members')}><Users /><span>{t('members')}</span></SidebarMenuButton></SidebarMenuItem>
        <SidebarMenuItem><SidebarMenuButton onClick={() => { setOpenMobile(false); onSettings('members', true) }} tooltip={t('inviteMembers')}><SquarePen /><span>{t('inviteMembers')}</span></SidebarMenuButton></SidebarMenuItem>
        <SidebarMenuItem><SidebarMenuButton render={<Link href="/devices" />} tooltip={t('devices')}><MonitorSmartphone /><span>{t('devices')}</span></SidebarMenuButton></SidebarMenuItem>
      </SidebarMenu>
      <NavUser user={user} onSettings={() => { setOpenMobile(false); onSettings('preferences') }} onSignOut={onSignOut} signingOut={signingOut} />
    </SidebarFooter>
    <SidebarRail aria-label={t('sidebarRail')} title={t('toggleSidebar')} aria-expanded={isMobile ? openMobile : open} />
  </Sidebar>
}
