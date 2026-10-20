"use client"

import * as React from "react"

import { NavMain } from "@/components/nav-main"
import { NavUser } from "@/components/nav-user"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import { Command, Eye, ListTodo, Search, SquarePen, UserRound, Users } from "lucide-react"
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'
import type { listIssues } from '@/app/actions/issues'
import { useSidebar } from '@/components/ui/sidebar'

import { ISSUE_STATUSES, WORKSPACE_NAME, type IssueView } from '@/components/workspace/issue-properties'

export function AppSidebar({ user, view, counts, recentIssues, selected, onNavigate, onOpen, onSearch, onCreate, onSignOut, signingOut, ...props }: React.ComponentProps<typeof Sidebar> & {
  user: { name: string; email: string }
  view: IssueView
  counts: Record<IssueView, number>
  recentIssues: Awaited<ReturnType<typeof listIssues>>
  selected: string | null
  onNavigate: (view: IssueView) => boolean
  onOpen: (id: string) => boolean
  onSearch: () => void
  onCreate: () => void
  onSignOut: () => void
  signingOut: boolean
}) {
  const { setOpenMobile } = useSidebar()
  function navigate(next: IssueView) { if (onNavigate(next)) setOpenMobile(false) }
  function create() { setOpenMobile(false); onCreate() }
  const personalItems = [
    { view: 'mine' as const, title: '我创建的', icon: UserRound },
    { view: 'shared' as const, title: '协作任务', icon: Users },
    { view: 'review' as const, title: 'In Review', icon: Eye },
  ]
  return (
    <Sidebar variant="inset" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" onClick={() => navigate('all')} aria-label={`${WORKSPACE_NAME} 全部任务`}>
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <Command className="size-4" />
              </div>
              <div className="flex flex-1 flex-col gap-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{WORKSPACE_NAME}</span>
                <span className="truncate text-xs text-muted-foreground">任务与文档</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="flex items-center gap-1 px-2 pb-1"><SidebarMenuButton onClick={() => { setOpenMobile(false); onSearch() }} tooltip="搜索任务（⌘ / Ctrl K）"><Search data-icon="inline-start" /><span>搜索任务</span><Kbd className="ml-auto">⌘ K</Kbd></SidebarMenuButton><Button variant="outline" size="icon-sm" aria-label="新建任务" title="新建任务（C）" onClick={create}><SquarePen data-icon="inline-start" /></Button></div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>个人</SidebarGroupLabel>
          <SidebarMenu>{personalItems.map(item => <SidebarMenuItem key={item.view}><SidebarMenuButton tooltip={item.title} isActive={!selected && view === item.view} onClick={() => navigate(item.view)}><item.icon /><span>{item.title}</span></SidebarMenuButton><SidebarMenuBadge>{counts[item.view]}</SidebarMenuBadge></SidebarMenuItem>)}</SidebarMenu>
        </SidebarGroup>
        <NavMain items={[{
          title: '全部任务', icon: ListTodo, count: counts.all, isActive: !selected && view === 'all', onClick: () => navigate('all'),
          items: ISSUE_STATUSES.map(status => ({ title: status.label, count: counts[status.value], isActive: !selected && view === status.value, onClick: () => navigate(status.value) })),
        }]} />
        {recentIssues.length > 0 && <SidebarGroup><SidebarGroupLabel>最近更新</SidebarGroupLabel><SidebarMenu>{recentIssues.slice(0, 5).map(issue => {
          const status = ISSUE_STATUSES.find(item => item.value === issue.status) ?? ISSUE_STATUSES[0]
          return <SidebarMenuItem key={issue.id}><SidebarMenuButton tooltip={issue.title} isActive={selected === issue.id} onClick={() => { if (onOpen(issue.id)) setOpenMobile(false) }}><status.icon className={cn('text-muted-foreground', status.value === 'doing' && 'text-warning-foreground', status.value === 'review' && 'text-success-foreground', status.value === 'done' && 'text-info-foreground')} /><span>{issue.title}</span></SidebarMenuButton></SidebarMenuItem>
        })}</SidebarMenu></SidebarGroup>}
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} onSignOut={onSignOut} signingOut={signingOut} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
