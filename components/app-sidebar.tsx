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
import { Command, Eye, ListTodo, MonitorSmartphone, Search, SquarePen, UserRound, Users } from "lucide-react"
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Kbd } from '@/components/ui/kbd'
import { cn } from '@/lib/utils'
import type { listIssues } from '@/app/actions/issues'
import { useSidebar } from '@/components/ui/sidebar'

import { ISSUE_STATUSES, WORKSPACE_NAME, type IssueView } from '@/components/workspace/issue-properties'

export function AppSidebar({ user, view, counts, recentIssues, selected, onNavigate, onOpen, onSearch, onCreate, onDevices, onSignOut, signingOut, ...props }: React.ComponentProps<typeof Sidebar> & {
  user: { name: string; email: string }
  view: IssueView
  counts: Record<IssueView, number>
  recentIssues: Awaited<ReturnType<typeof listIssues>>
  selected: string | null
  onNavigate: (view: IssueView) => boolean
  onOpen: (id: string) => boolean
  onSearch: () => void
  onCreate: () => void
  onDevices: () => void
  onSignOut: () => void
  signingOut: boolean
}) {
  const { setOpenMobile } = useSidebar()
  const t = useTranslations('Nav')
  const commonT = useTranslations('Common')
  const statusT = useTranslations('Issue.status')
  const statusLabel = (value: string) => statusT.has(value as never) ? statusT(value as never) : value
  function navigate(next: IssueView) { if (onNavigate(next)) setOpenMobile(false) }
  function create() { setOpenMobile(false); onCreate() }
  const personalItems = [
    { view: 'mine' as const, title: t('mine'), icon: UserRound },
    { view: 'shared' as const, title: t('shared'), icon: Users },
    { view: 'review' as const, title: statusLabel('review'), icon: Eye },
  ]
  return (
    <Sidebar variant="inset" mobileTitle={t('sidebarTitle')} mobileDescription={t('sidebarDescription')} mobileCloseLabel={commonT('close')} {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" onClick={() => navigate('all')} aria-label={t('workspaceAll', { name: WORKSPACE_NAME })}>
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                <Command className="size-4" />
              </div>
              <div className="flex flex-1 flex-col gap-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{WORKSPACE_NAME}</span>
                <span className="truncate text-xs text-muted-foreground">{t('tagline')}</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="flex items-center gap-1 px-2 pb-1"><SidebarMenuButton onClick={() => { setOpenMobile(false); onSearch() }} tooltip={t('searchTooltip')}><Search data-icon="inline-start" /><span>{t('search')}</span><Kbd className="ml-auto">⌘ K</Kbd></SidebarMenuButton><Button variant="outline" size="icon-sm" aria-label={t('newTask')} title={t('newTaskHint')} onClick={create}><SquarePen data-icon="inline-start" /></Button></div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{t('personal')}</SidebarGroupLabel>
          <SidebarMenu>{personalItems.map(item => <SidebarMenuItem key={item.view}><SidebarMenuButton tooltip={item.title} isActive={!selected && view === item.view} onClick={() => navigate(item.view)}><item.icon /><span>{item.title}</span></SidebarMenuButton><SidebarMenuBadge>{counts[item.view]}</SidebarMenuBadge></SidebarMenuItem>)}</SidebarMenu>
        </SidebarGroup>
        <NavMain items={[{
          title: t('allIssues'), icon: ListTodo, count: counts.all, isActive: !selected && view === 'all', onClick: () => navigate('all'),
          items: ISSUE_STATUSES.map(status => ({ title: statusLabel(status.value), count: counts[status.value], isActive: !selected && view === status.value, onClick: () => navigate(status.value) })),
        }]} />
        {recentIssues.length > 0 && <SidebarGroup><SidebarGroupLabel>{t('recent')}</SidebarGroupLabel><SidebarMenu>{recentIssues.slice(0, 5).map(issue => {
          const status = ISSUE_STATUSES.find(item => item.value === issue.status) ?? ISSUE_STATUSES[0]
          return <SidebarMenuItem key={issue.id}><SidebarMenuButton tooltip={issue.title} isActive={selected === issue.id} onClick={() => { if (onOpen(issue.id)) setOpenMobile(false) }}><status.icon className={cn('text-muted-foreground', status.value === 'doing' && 'text-warning-foreground', status.value === 'review' && 'text-success-foreground', status.value === 'done' && 'text-info-foreground')} /><span>{issue.title}</span></SidebarMenuButton></SidebarMenuItem>
        })}</SidebarMenu></SidebarGroup>}
        <SidebarGroup>
          <SidebarGroupLabel>{t('automation')}</SidebarGroupLabel>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton tooltip={t('devices')} onClick={onDevices}>
                <MonitorSmartphone />
                <span>{t('devices')}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} onSignOut={onSignOut} signingOut={signingOut} />
      </SidebarFooter>
      <SidebarRail label={t('toggleSidebar')} />
    </Sidebar>
  )
}
