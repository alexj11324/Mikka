'use client'
import { useTranslations } from 'next-intl'

import { useEffect, useRef, useState } from 'react'
import { SettingsLink as Link } from './settings-link'
import { useSearchParams } from 'next/navigation'
import useSWR from 'swr'
import { ArrowLeft, Bell, Blocks, Bot, Brain, Building2, ChartColumn, CircleCheck, CreditCard, FileText, Gauge, HardDrive, History, KeyRound, Lock, Monitor, Plus, Search, Shield, SlidersHorizontal, SquareTerminal, SquareUserRound, UserRound, Users, type LucideIcon } from 'lucide-react'
import { listTeams } from '@/app/actions/teams'
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarInput, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarRail, useSidebar } from '@/components/ui/sidebar'
import { WorkspaceMenu } from '@/components/workspace-menu'
import { pushSettingsHistory } from '@/lib/settings-navigation'
import { settingsItemVisible } from '@/lib/settings-sidebar-search'
import { resolveSettingsSection, settingsHref, visibleSettingsSections, type SettingsSectionId } from '@/lib/settings-sections'

const icons: Record<SettingsSectionId, LucideIcon> = {
  account: UserRound, security: Shield, preferences: SlidersHorizontal, notifications: Bell, memory: Brain, connections: Blocks,
  models: Gauge, logins: KeyRound, privacy: Lock, activity: History, computers: Monitor, developer: SquareTerminal,
  general: Building2, members: Users, teams: SquareUserRound, bots: Bot, permissions: CircleCheck, secrets: HardDrive,
  audit: FileText, usage: ChartColumn, billing: CreditCard,
}

export function SettingsSidebar({ user, section, activeSection, admin, selectedTeamId, workspaceId, onSectionChange, onBack, onSignOut, signingOut }: {
  user: { name: string; email: string; image?: string | null }
  section: SettingsSectionId
  activeSection?: SettingsSectionId
  /** Viewer is a workspace admin. Admin-only sections stay hidden until this is known (S-P). */
  admin: boolean
  selectedTeamId?: string
  workspaceId?: string
  onSectionChange: (section: SettingsSectionId) => void
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
  const href = (id: SettingsSectionId) => settingsHref(id, workspaceId)
  function openSettings(href = '/settings') {
    const destination = new URL(href, window.location.origin)
    if (activeSection) {
      if (workspaceId) destination.searchParams.set('workspace', workspaceId)
      pushSettingsHistory(`${destination.pathname}${destination.search}`, workspaceId)
      return
    }
    onSectionChange(resolveSettingsSection(destination.pathname, destination.searchParams.get('section')))
  }
  return <Sidebar variant="sidebar" aria-label={i18nText("FeatureCopy.c_a8c7ae4f")}>
    <SidebarHeader className="px-4 pt-3 pb-2">
      <SidebarMenu><SidebarMenuItem><WorkspaceMenu user={user} onSettings={openSettings} onSignOut={onSignOut} signingOut={signingOut} /></SidebarMenuItem></SidebarMenu>
      <SidebarMenu><SidebarMenuItem><SidebarMenuButton aria-label={i18nText("Invite.backToWorkspace")} render={activeSection ? <Link href={selectedTeamId ? `/?team=${encodeURIComponent(selectedTeamId)}` : '/'} /> : undefined} onClick={() => { setOpenMobile(false); if (!activeSection) onBack() }}><ArrowLeft /><span>{i18nText("Settings.backToApp")}</span></SidebarMenuButton></SidebarMenuItem></SidebarMenu>
      <div className="relative mt-3"><Search className="pointer-events-none absolute top-2 left-2 size-4 text-muted-foreground" aria-hidden="true" /><SidebarInput className="pl-8" aria-label={i18nText("Settings.searchLabel")} placeholder={i18nText("Settings.searchPlaceholder")} value={query} onChange={event => setQuery(event.target.value)} /></div>
    </SidebarHeader>
    <SidebarContent ref={contentRef} className="px-2 pb-6">
      {(['personal', 'workspace'] as const).map(group => {
        const groupLabel = i18nText(`Settings.groups.${group}`)
        const items = visibleSettingsSections({ admin }).filter(item => item.group === group && settingsItemVisible({
          query, groupTitle: group === 'personal' ? 'Personal' : 'Workspace', groupLabel, itemTitle: item.title,
          label: i18nText(`Settings.sections.${item.id}.title` as never),
          keywords: i18nText.has(`Settings.sections.${item.id}.keywords` as never) ? i18nText(`Settings.sections.${item.id}.keywords` as never) : '',
          section: item.id, routed: Boolean(activeSection),
        }))
        return items.length > 0 && <SidebarGroup key={group} className="py-2"><SidebarGroupLabel>{groupLabel}</SidebarGroupLabel><SidebarMenu>{items.map(item => {
          const Icon = icons[item.id]
          const label = i18nText(`Settings.sections.${item.id}.title` as never)
          const selected = item.id === section && !selectedTeamId && !creating
          return <SidebarMenuItem key={item.id}><SidebarMenuButton aria-label={label} render={activeSection ? <Link href={href(item.id)} /> : undefined} isActive={selected} aria-current={selected ? 'page' : undefined} onClick={() => { if (!activeSection) onSectionChange(item.id); setOpenMobile(false) }}><Icon /><span>{label}</span></SidebarMenuButton></SidebarMenuItem>
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
