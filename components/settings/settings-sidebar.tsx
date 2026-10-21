'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import useSWR from 'swr'
import { ArrowLeft, Blocks, Building2, ChevronDown, ChevronRight, CircleDot, Flag, Folder, GitBranch, KeyRound, Link2, PanelsTopLeft, Plus, Search, ShieldCheck, SlidersHorizontal, SquareUserRound, Tags, UserRound, Users, Webhook } from 'lucide-react'
import { listTeams } from '@/app/actions/teams'
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarInput, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem, SidebarRail, useSidebar } from '@/components/ui/sidebar'
import { NavUser } from '@/components/nav-user'
import type { SettingsSection } from './settings-view'

const navigation = [
  { title: 'Personal', items: [
    { title: 'Preferences', label: '偏好设置', section: 'preferences', icon: SlidersHorizontal },
    { title: 'Profile', label: '个人资料', section: 'profile', icon: UserRound },
  ] },
  { title: 'Workspace', items: [
    { title: 'General', label: '工作区', section: 'workspace', icon: Building2 },
    { title: 'Members', label: '成员', section: 'members', icon: Users },
    { title: 'Teams', label: '团队', section: 'teams', icon: SquareUserRound },
  ] },
  { title: 'Features', items: [
    { title: 'Initiatives', icon: Flag },
    { title: 'Projects', icon: Folder },
    { title: 'Workflows', icon: GitBranch },
    { title: 'Labels', icon: Tags },
    { title: 'Templates', icon: PanelsTopLeft },
  ] },
  { title: 'Integrations', items: [
    { title: 'Integrations', icon: Blocks },
    { title: 'Webhooks', icon: Webhook },
  ] },
  { title: 'Administration', items: [
    { title: 'API', icon: KeyRound },
    { title: 'OAuth applications', icon: Link2 },
    { title: 'Security', icon: ShieldCheck },
  ] },
] as const

export function SettingsSidebar({ user, section, activeSection, selectedTeamId, workspaceId, onSectionChange, onBack, onSignOut, signingOut }: {
  user: { name: string; email: string; image?: string | null }
  section: SettingsSection
  activeSection?: SettingsSection
  selectedTeamId?: string
  workspaceId?: string
  onSectionChange: (section: SettingsSection) => void
  onBack: () => void
  onSignOut: () => void
  signingOut: boolean
}) {
  const [query, setQuery] = useState('')
  const params = useSearchParams()
  const creating = params.get('create') === '1'
  const teamView = params.get('view')
  const { setOpenMobile } = useSidebar()
  const { data: teams = [], error, mutate } = useSWR(activeSection ? 'teams' : null, listTeams)
  const contentRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if ((creating || selectedTeamId) && contentRef.current) contentRef.current.scrollTop = contentRef.current.scrollHeight
  }, [creating, selectedTeamId, teams.length])
  const normalizedQuery = query.trim().toLowerCase()
  const joinedTeams = teams.filter(team => team.role && (!workspaceId || team.workspaceId === workspaceId) && `${team.name} ${team.identifier}`.toLowerCase().includes(normalizedQuery))
  function href(id: SettingsSection) {
    const search = new URLSearchParams(workspaceId ? { workspace: workspaceId } : {})
    if (id !== 'members' && id !== 'teams') search.set('section', id)
    return `${id === 'members' || id === 'teams' ? `/settings/${id}` : '/settings'}?${search}`
  }
  return <Sidebar variant="sidebar" aria-label="设置导航">
    <SidebarHeader className="px-4 pt-5 pb-2">
      <SidebarMenu><SidebarMenuItem><SidebarMenuButton aria-label="返回工作台" render={activeSection ? <Link href={selectedTeamId ? `/?team=${encodeURIComponent(selectedTeamId)}` : '/'} /> : undefined} onClick={() => { setOpenMobile(false); if (!activeSection) onBack() }}><ArrowLeft /><span lang="en">Back to workspace</span></SidebarMenuButton></SidebarMenuItem></SidebarMenu>
      <div className="relative mt-3"><Search className="pointer-events-none absolute top-2 left-2 size-4 text-muted-foreground" aria-hidden="true" /><SidebarInput className="pl-8" aria-label="搜索设置" placeholder="Search settings…" value={query} onChange={event => setQuery(event.target.value)} /></div>
    </SidebarHeader>
    <SidebarContent ref={contentRef} className="px-2 pb-6">
      {navigation.map(group => {
        const items = group.items.filter(item => `${group.title} ${item.title} ${'label' in item ? item.label : ''}`.toLowerCase().includes(normalizedQuery) && (activeSection || !('section' in item) || (item.section !== 'teams' && item.section !== 'members')))
        return items.length > 0 && <SidebarGroup key={group.title} className="py-3"><SidebarGroupLabel lang="en">{group.title}</SidebarGroupLabel><SidebarMenu className="gap-1">{items.map(item => {
          const id = 'section' in item ? item.section : undefined
          const selected = id === section && !selectedTeamId && !creating
          return <SidebarMenuItem key={item.title}><SidebarMenuButton aria-label={'label' in item ? item.label : item.title} disabled={!id} title={!id ? '暂未开放' : undefined} render={id && activeSection ? <Link href={href(id)} /> : undefined} isActive={selected} aria-current={selected ? 'page' : undefined} onClick={() => { if (id && !activeSection) onSectionChange(id); setOpenMobile(false) }}><item.icon /><span lang="en">{item.title}</span></SidebarMenuButton></SidebarMenuItem>
        })}</SidebarMenu></SidebarGroup>
      })}
      {activeSection && <SidebarGroup className="py-3"><SidebarGroupLabel lang="en">Your teams</SidebarGroupLabel><SidebarMenu className="gap-1">{joinedTeams.map(team => {
        const selected = selectedTeamId === team.id
        const teamHref = `/settings/teams?workspace=${encodeURIComponent(team.workspaceId)}&team=${encodeURIComponent(team.id)}`
        return <SidebarMenuItem key={team.id}><SidebarMenuButton render={<Link href={teamHref} />} isActive={selected} aria-current={selected ? 'page' : undefined} onClick={() => setOpenMobile(false)}><CircleDot /><span>{team.name}</span>{selected ? <ChevronDown className="ml-auto" /> : <ChevronRight className="ml-auto" />}</SidebarMenuButton>{selected && <SidebarMenuSub className="ml-4 border-0 pl-4"><SidebarMenuSubItem><SidebarMenuSubButton render={<Link href={`${teamHref}&view=general`} />} isActive={teamView !== 'members'} aria-label="团队常规设置" onClick={() => setOpenMobile(false)}><span lang="en">General</span></SidebarMenuSubButton></SidebarMenuSubItem><SidebarMenuSubItem><SidebarMenuSubButton render={<Link href={`${teamHref}&view=members`} />} isActive={teamView === 'members'} aria-label="团队成员设置" onClick={() => setOpenMobile(false)}><span lang="en">Members</span></SidebarMenuSubButton></SidebarMenuSubItem></SidebarMenuSub>}</SidebarMenuItem>
      })}<SidebarMenuItem><SidebarMenuButton render={<Link href={`${href('teams')}&create=1`} />} aria-label="创建团队" isActive={creating} aria-current={creating ? 'page' : undefined} onClick={() => setOpenMobile(false)}><Plus /><span lang="en">Create team</span></SidebarMenuButton></SidebarMenuItem>{error && <SidebarMenuItem><SidebarMenuButton onClick={() => void mutate()}>团队读取失败，重试</SidebarMenuButton></SidebarMenuItem>}</SidebarMenu></SidebarGroup>}
    </SidebarContent>
    <SidebarFooter className="px-4"><NavUser user={user} onSignOut={onSignOut} signingOut={signingOut} /></SidebarFooter>
    <SidebarRail />
  </Sidebar>
}
