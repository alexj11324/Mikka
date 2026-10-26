'use client'
import { useTranslations } from 'next-intl'

import { useEffect, useRef, useState } from 'react'
import { SettingsLink as Link } from './settings-link'
import { useSearchParams } from 'next/navigation'
import useSWR from 'swr'
import { ArrowLeft, Building2, KeyRound, Monitor, Plus, Plug, Search, SlidersHorizontal, SquareUserRound, UserRound, Users } from 'lucide-react'
import { listTeams } from '@/app/actions/teams'
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarInput, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarRail, useSidebar } from '@/components/ui/sidebar'
import { WorkspaceMenu } from '@/components/workspace-menu'
import { pushSettingsHistory } from '@/lib/settings-navigation'
import { settingsItemVisible } from '@/lib/settings-sidebar-search'
import type { SettingsSection } from './settings-view'

const navigation = [
  { title: 'Personal', key: 'personal', items: [
    { title: 'Preferences', section: 'preferences', icon: SlidersHorizontal },
    { title: 'Profile', section: 'profile', icon: UserRound },
    { title: 'Account', section: 'account', icon: KeyRound },
    { title: 'Integrations', section: 'integrations', icon: Plug },
    { title: 'Devices', section: 'devices', icon: Monitor },
  ] },
  { title: 'Administration', key: 'administration', items: [
    { title: 'Workspace', section: 'workspace', icon: Building2 },
    { title: 'Teams', section: 'teams', icon: SquareUserRound },
    { title: 'Members', section: 'members', icon: Users },
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
  const i18nText = useTranslations();
  const [query, setQuery] = useState('')
  const params = useSearchParams()
  const creating = params.get('create') === '1'
  const { setOpenMobile } = useSidebar()
  const { data: teams = [], error, mutate } = useSWR(activeSection ? 'teams' : null, listTeams)
  const contentRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    contentRef.current?.querySelector('[aria-current="page"]')?.closest('[data-slot="sidebar-group"]')?.scrollIntoView({ block: 'nearest' })
  }, [creating, section, selectedTeamId, teams.length])
  const normalizedQuery = query.trim().toLowerCase()
  const joinedTeams = teams.filter(team => team.role && (!workspaceId || team.workspaceId === workspaceId) && `${team.name} ${team.identifier}`.toLowerCase().includes(normalizedQuery))
  function href(id: SettingsSection) {
    const search = new URLSearchParams(workspaceId ? { workspace: workspaceId } : {})
    if (id !== 'members' && id !== 'teams') search.set('section', id)
    return `${id === 'members' || id === 'teams' ? `/settings/${id}` : '/settings'}?${search}`
  }
  function openSettings(href = '/settings') {
    const destination = new URL(href, window.location.origin)
    if (activeSection) {
      if (workspaceId) destination.searchParams.set('workspace', workspaceId)
      pushSettingsHistory(`${destination.pathname}${destination.search}`, workspaceId)
      return
    }
    const next = destination.pathname.endsWith('/members') ? 'members' : destination.searchParams.get('section')
    onSectionChange(next === 'profile' || next === 'account' || next === 'workspace' || next === 'members' || next === 'integrations' || next === 'devices' ? next : 'preferences')
  }
  return <Sidebar variant="sidebar" aria-label={i18nText("FeatureCopy.c_a8c7ae4f")}>
    <SidebarHeader className="px-4 pt-3 pb-2">
      <SidebarMenu><SidebarMenuItem><WorkspaceMenu user={user} onSettings={openSettings} onSignOut={onSignOut} signingOut={signingOut} /></SidebarMenuItem></SidebarMenu>
      <SidebarMenu><SidebarMenuItem><SidebarMenuButton aria-label={i18nText("Invite.backToWorkspace")} render={activeSection ? <Link href={selectedTeamId ? `/?team=${encodeURIComponent(selectedTeamId)}` : '/'} /> : undefined} onClick={() => { setOpenMobile(false); if (!activeSection) onBack() }}><ArrowLeft /><span>{i18nText("Settings.backToApp")}</span></SidebarMenuButton></SidebarMenuItem></SidebarMenu>
      <div className="relative mt-3"><Search className="pointer-events-none absolute top-2 left-2 size-4 text-muted-foreground" aria-hidden="true" /><SidebarInput className="pl-8" aria-label={i18nText("Settings.searchLabel")} placeholder={i18nText("Settings.searchPlaceholder")} value={query} onChange={event => setQuery(event.target.value)} /></div>
    </SidebarHeader>
    <SidebarContent ref={contentRef} className="px-2 pb-6">
      {navigation.map(group => {
        const items = group.items.filter(item => {
          const label = i18nText(`Settings.sections.${item.section}.title` as never)
          return settingsItemVisible({ query, groupTitle: group.title, groupLabel: i18nText(`Settings.groups.${group.key}`), itemTitle: item.title, label, section: item.section, routed: Boolean(activeSection) })
        })
        return items.length > 0 && <SidebarGroup key={group.key} className="py-2"><SidebarGroupLabel>{i18nText(`Settings.groups.${group.key}`)}</SidebarGroupLabel><SidebarMenu>{items.map(item => {
          const id = item.section
          const label = i18nText(`Settings.sections.${id}.title` as never)
          const selected = id === section && !selectedTeamId && !creating
          return <SidebarMenuItem key={item.title}><SidebarMenuButton aria-label={label} render={activeSection ? <Link href={href(id)} /> : undefined} isActive={selected} aria-current={selected ? 'page' : undefined} onClick={() => { if (!activeSection) onSectionChange(id); setOpenMobile(false) }}><item.icon /><span>{label}</span></SidebarMenuButton></SidebarMenuItem>
        })}</SidebarMenu></SidebarGroup>
      })}
      {activeSection && <SidebarGroup className="py-2"><SidebarGroupLabel>{i18nText("Settings.groups.yourTeams")}</SidebarGroupLabel><SidebarMenu>{joinedTeams.map(team => {
        const selected = selectedTeamId === team.id
        const teamHref = `/settings/teams?workspace=${encodeURIComponent(team.workspaceId)}&team=${encodeURIComponent(team.id)}`
        return <SidebarMenuItem key={team.id}><SidebarMenuButton render={<Link href={teamHref} />} isActive={selected} aria-current={selected ? 'page' : undefined} onClick={() => setOpenMobile(false)}><SquareUserRound className="text-info" /><span>{team.name}</span></SidebarMenuButton></SidebarMenuItem>
      })}<SidebarMenuItem><SidebarMenuButton render={<Link href={`${href('teams')}&create=1`} />} aria-label={i18nText("FeatureCopy.c_cb11190c")} isActive={creating} aria-current={creating ? 'page' : undefined} onClick={() => setOpenMobile(false)}><Plus /><span>{i18nText("Settings.nav.createTeam")}</span></SidebarMenuButton></SidebarMenuItem>{error && <SidebarMenuItem><SidebarMenuButton onClick={() => void mutate()}>{i18nText("FeatureCopy.c_c401eee8")}</SidebarMenuButton></SidebarMenuItem>}</SidebarMenu></SidebarGroup>}
    </SidebarContent>
    <SidebarRail />
  </Sidebar>
}
