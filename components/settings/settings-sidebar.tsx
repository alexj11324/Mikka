'use client'

import { useEffect, useRef, useState } from 'react'
import { SettingsLink as Link } from './settings-link'
import { useSearchParams } from 'next/navigation'
import useSWR from 'swr'
import { Activity, ArrowLeft, ArrowLeftRight, Blocks, Building2, ChartNoAxesCombined, CodeXml, ContactRound, CreditCard, FileText, Flag, Grid2X2, HandHelping, Orbit, PackageCheck, Plus, Search, ShieldCheck, SlidersHorizontal, Smile, Sparkles, SquareUserRound, UserRound, Users } from 'lucide-react'
import { listTeams } from '@/app/actions/teams'
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarInput, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarRail, useSidebar } from '@/components/ui/sidebar'
import { NavUser } from '@/components/nav-user'
import type { SettingsSection } from './settings-view'
import { useFeatureAvailability } from '@/hooks/use-feature-availability'

function GithubIcon() { return <img src="/icons/github.svg" alt="" className="size-4 shrink-0" /> }

const navigation = [
  { title: 'Personal', items: [
    { title: 'Preferences', label: '偏好设置', section: 'preferences', icon: SlidersHorizontal },
    { title: 'Profile', label: '个人资料', section: 'profile', icon: UserRound },
  ] },
  { title: 'Features', items: [
    { title: 'AI & agents', icon: Sparkles },
    { title: 'Loops', icon: Orbit },
    { title: 'Initiatives', icon: Flag },
    { title: 'Documents', icon: FileText },
    { title: 'Customer requests', icon: ContactRound },
    { title: 'Releases', icon: PackageCheck },
    { title: 'Pulse', icon: Activity },
    { title: 'Asks', icon: HandHelping },
    { title: 'Emojis', icon: Smile },
  ] },
  { title: 'Integrations', items: [
    { title: 'All integrations', icon: Blocks },
    { title: 'GitHub', icon: GithubIcon },
  ] },
  { title: 'Administration', items: [
    { title: 'Workspace', label: '工作区', section: 'workspace', icon: Building2 },
    { title: 'Teams', label: '团队', section: 'teams', icon: SquareUserRound },
    { title: 'Members', label: '成员', section: 'members', icon: Users },
    { title: 'Security', icon: ShieldCheck },
    { title: 'API', icon: CodeXml },
    { title: 'Applications', icon: Grid2X2 },
    { title: 'Billing', icon: CreditCard },
    { title: 'Usage & limits', icon: ChartNoAxesCombined },
    { title: 'Import & export', icon: ArrowLeftRight },
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
  const { setOpenMobile } = useSidebar()
  const { data: teams = [], error, mutate } = useSWR(activeSection ? 'teams' : null, listTeams)
  const contentRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    contentRef.current?.querySelector('[aria-current="page"]')?.closest('[data-slot="sidebar-group"]')?.scrollIntoView({ block: 'nearest' })
  }, [creating, section, selectedTeamId, teams.length])
  const productRelease = useFeatureAvailability('product')
  const integrationsRelease = useFeatureAvailability('integrations')
  const administrationRelease = useFeatureAvailability('administration')
  const normalizedQuery = query.trim().toLowerCase()
  const joinedTeams = teams.filter(team => team.role && (!workspaceId || team.workspaceId === workspaceId) && `${team.name} ${team.identifier}`.toLowerCase().includes(normalizedQuery))
  function href(id: SettingsSection) {
    const search = new URLSearchParams(workspaceId ? { workspace: workspaceId } : {})
    if (id !== 'members' && id !== 'teams') search.set('section', id)
    return `${id === 'members' || id === 'teams' ? `/settings/${id}` : '/settings'}?${search}`
  }
  return <Sidebar variant="sidebar" aria-label="设置导航">
    <SidebarHeader className="px-4 pt-5 pb-2">
      <SidebarMenu><SidebarMenuItem><SidebarMenuButton aria-label="返回工作台" render={activeSection ? <Link href={selectedTeamId ? `/?team=${encodeURIComponent(selectedTeamId)}` : '/'} /> : undefined} onClick={() => { setOpenMobile(false); if (!activeSection) onBack() }}><ArrowLeft /><span lang="en">Back to app</span></SidebarMenuButton></SidebarMenuItem></SidebarMenu>
      <div className="relative mt-3"><Search className="pointer-events-none absolute top-2 left-2 size-4 text-muted-foreground" aria-hidden="true" /><SidebarInput className="pl-8" aria-label="搜索设置" placeholder="Search…" value={query} onChange={event => setQuery(event.target.value)} /></div>
    </SidebarHeader>
    <SidebarContent ref={contentRef} className="px-2 pb-6">
      {navigation.map(group => {
        const items = group.items.filter(item => `${group.title} ${item.title} ${'label' in item ? item.label : ''}`.toLowerCase().includes(normalizedQuery) && (activeSection || !('section' in item) || (item.section !== 'teams' && item.section !== 'members')))
        return items.length > 0 && <SidebarGroup key={group.title} className="py-2"><SidebarGroupLabel lang="en">{group.title}</SidebarGroupLabel><SidebarMenu>{items.map(item => {
          const id = 'section' in item ? item.section : undefined
          const selected = id === section && !selectedTeamId && !creating
          const release = id ? undefined : group.title === 'Features' ? productRelease : group.title === 'Integrations' ? integrationsRelease : administrationRelease
          return <SidebarMenuItem key={item.title}><SidebarMenuButton aria-label={'label' in item ? item.label : item.title} disabled={!id || !!release && !release.enabled} data-feature-flag={release?.key} title={release?.reason} render={id && activeSection ? <Link href={href(id)} /> : undefined} isActive={selected} aria-current={selected ? 'page' : undefined} onClick={() => { if (id && !activeSection) onSectionChange(id); setOpenMobile(false) }}><item.icon /><span lang="en">{item.title}</span></SidebarMenuButton></SidebarMenuItem>
        })}</SidebarMenu></SidebarGroup>
      })}
      {activeSection && <SidebarGroup className="py-2"><SidebarGroupLabel lang="en">Your teams</SidebarGroupLabel><SidebarMenu>{joinedTeams.map(team => {
        const selected = selectedTeamId === team.id
        const teamHref = `/settings/teams?workspace=${encodeURIComponent(team.workspaceId)}&team=${encodeURIComponent(team.id)}`
        return <SidebarMenuItem key={team.id}><SidebarMenuButton render={<Link href={teamHref} />} isActive={selected} aria-current={selected ? 'page' : undefined} onClick={() => setOpenMobile(false)}><SquareUserRound className="text-info" /><span>{team.name}</span></SidebarMenuButton></SidebarMenuItem>
      })}<SidebarMenuItem><SidebarMenuButton render={<Link href={`${href('teams')}&create=1`} />} aria-label="创建团队" isActive={creating} aria-current={creating ? 'page' : undefined} onClick={() => setOpenMobile(false)}><Plus /><span lang="en">Create a team</span></SidebarMenuButton></SidebarMenuItem>{error && <SidebarMenuItem><SidebarMenuButton onClick={() => void mutate()}>团队读取失败，重试</SidebarMenuButton></SidebarMenuItem>}</SidebarMenu></SidebarGroup>}
    </SidebarContent>
    <SidebarFooter className="px-4"><NavUser user={user} onSignOut={onSignOut} signingOut={signingOut} /></SidebarFooter>
    <SidebarRail />
  </Sidebar>
}
