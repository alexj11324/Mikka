'use client'

import * as React from 'react'
import Link from 'next/link'
import { Box, ChevronDown, CircleHelp, Ellipsis, House, Inbox, Layers, Scan, Search, Send, SquarePen, SquareUserRound, Users } from 'lucide-react'
import { NavUser } from '@/components/nav-user'
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubItem, SidebarMenuSubButton, SidebarRail, useSidebar } from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { WORKSPACE_NAME } from '@/components/workspace/issue-properties'
import type { WorkspaceSection } from '@/components/workspace/workspace-navigation'

export function AppSidebar({ user, section, onNavigate, onSearch, onCreate, onSignOut, signingOut, ...props }: React.ComponentProps<typeof Sidebar> & {
  user: { name: string; email: string; image?: string | null }
  section: WorkspaceSection
  onNavigate: (section: WorkspaceSection) => boolean
  onSearch: () => void
  onCreate: () => void
  onSignOut: () => void
  signingOut: boolean
}) {
  const { setOpenMobile, open, openMobile, isMobile } = useSidebar()
  function navigate(next: WorkspaceSection) { if (onNavigate(next)) setOpenMobile(false) }
  const personal = [{ id: 'inbox', title: '收件箱', icon: Inbox }, { id: 'my-issues', title: '我的任务', icon: Scan }, { id: 'agent', title: 'Agent', icon: Send }] as const
  const teamItems = [{ id: 'team-home', title: '主页', icon: House }, { id: 'team-issues', title: '任务', icon: Layers }, { id: 'team-projects', title: '项目', icon: Box }] as const
  return <Sidebar variant="inset" {...props}>
    <SidebarHeader className="pb-4">
      <div className="flex items-center gap-1">
        <SidebarMenu className="min-w-0 flex-1"><SidebarMenuItem>
          <DropdownMenu><DropdownMenuTrigger render={<SidebarMenuButton aria-label="工作区菜单" className="h-10" />}>
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-sidebar-primary text-xs font-semibold text-sidebar-primary-foreground">O</span><span className="flex-1 font-semibold">{WORKSPACE_NAME}</span><ChevronDown />
          </DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuGroup><DropdownMenuItem onClick={() => navigate('projects')}><Box />工作区项目</DropdownMenuItem><DropdownMenuItem onClick={() => navigate('team-home')}><SquareUserRound />团队主页</DropdownMenuItem></DropdownMenuGroup></DropdownMenuContent></DropdownMenu>
        </SidebarMenuItem></SidebarMenu>
        <Button variant="ghost" size="icon-sm" aria-label="搜索任务" title="搜索任务（⌘ / Ctrl K）" onClick={() => { setOpenMobile(false); onSearch() }}><Search data-icon="inline-start" /></Button>
        <Button variant="secondary" size="icon-sm" aria-label="新建任务" title="新建任务（C）" onClick={() => { setOpenMobile(false); onCreate() }}><SquarePen data-icon="inline-start" /></Button>
      </div>
    </SidebarHeader>
    <SidebarContent className="gap-5">
      <SidebarGroup className="pt-0"><SidebarMenu>{personal.map(item => <SidebarMenuItem key={item.id}><SidebarMenuButton tooltip={item.title} isActive={section === item.id} onClick={() => navigate(item.id)}><item.icon /><span>{item.title}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></SidebarGroup>
      <Collapsible defaultOpen className="group/workspace"><SidebarGroup>
        <SidebarGroupLabel render={<CollapsibleTrigger />} className="mb-1 cursor-pointer">工作区<ChevronDown className="ml-1 transition-transform group-data-closed/workspace:-rotate-90" /></SidebarGroupLabel>
        <CollapsibleContent><SidebarMenu>
          <SidebarMenuItem><SidebarMenuButton isActive={section === 'projects'} onClick={() => navigate('projects')}><Box /><span>项目</span></SidebarMenuButton></SidebarMenuItem>
          <SidebarMenuItem><SidebarMenuButton isActive={section === 'views'} onClick={() => navigate('views')}><Layers /><span>视图</span></SidebarMenuButton></SidebarMenuItem>
          <SidebarMenuItem><DropdownMenu><DropdownMenuTrigger render={<SidebarMenuButton />}><Ellipsis /><span>更多</span></DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuGroup><DropdownMenuItem onClick={() => navigate('all-issues')}><Layers />全部任务</DropdownMenuItem><DropdownMenuItem render={<a href="https://linear.app/docs/projects" target="_blank" rel="noreferrer" />}><CircleHelp />项目使用指南</DropdownMenuItem></DropdownMenuGroup></DropdownMenuContent></DropdownMenu></SidebarMenuItem>
        </SidebarMenu></CollapsibleContent>
      </SidebarGroup></Collapsible>
      <Collapsible defaultOpen className="group/teams"><SidebarGroup>
        <SidebarGroupLabel render={<CollapsibleTrigger />} className="mb-1 cursor-pointer">你的团队<ChevronDown className="ml-1 transition-transform group-data-closed/teams:-rotate-90" /></SidebarGroupLabel>
        <CollapsibleContent><SidebarMenu><SidebarMenuItem>
          <Collapsible defaultOpen className="group/team"><CollapsibleTrigger render={<SidebarMenuButton aria-label={`展开或收起 ${WORKSPACE_NAME} 团队`} />}><SquareUserRound className="text-info-foreground" /><span>{WORKSPACE_NAME}</span><ChevronDown className="ml-auto transition-transform group-data-closed/team:-rotate-90" /></CollapsibleTrigger>
            <CollapsibleContent><SidebarMenuSub className="mx-0 ml-4 border-0 px-0">{teamItems.map(item => <SidebarMenuSubItem key={item.id}><SidebarMenuSubButton render={<Button variant="ghost" />} isActive={section === item.id} onClick={() => navigate(item.id)}><item.icon /><span>{item.title}</span></SidebarMenuSubButton></SidebarMenuSubItem>)}</SidebarMenuSub></CollapsibleContent>
          </Collapsible>
        </SidebarMenuItem></SidebarMenu></CollapsibleContent>
      </SidebarGroup></Collapsible>
    </SidebarContent>
    <SidebarFooter>
      <SidebarMenu>
        <SidebarMenuItem><SidebarMenuButton render={<Link href="/settings/members" />} tooltip="成员管理"><Users /><span>成员管理</span></SidebarMenuButton></SidebarMenuItem>
        <SidebarMenuItem><SidebarMenuButton render={<Link href="/settings/members?invite=1" />} tooltip="邀请成员"><SquarePen /><span>邀请成员</span></SidebarMenuButton></SidebarMenuItem>
      </SidebarMenu>
      <NavUser user={user} onSignOut={onSignOut} signingOut={signingOut} />
    </SidebarFooter>
    <SidebarRail aria-label="展开或收起侧栏边轨" title="展开或收起侧栏" aria-expanded={isMobile ? openMobile : open} />
  </Sidebar>
}
