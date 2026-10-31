'use client'
import { useTranslations } from 'next-intl'

import { useEffect, useRef, useState } from 'react'
import { SettingsLink as Link } from './settings-link'
import { useSearchParams } from 'next/navigation'
import useSWR from 'swr'
import { Bell, Blocks, Bot, Brain, Building2, ChartColumn, CircleCheck, CreditCard, FileText, Gauge, HardDrive, KeyRound, Lock, Monitor, Plus, Search, Shield, SlidersHorizontal, SquareTerminal, SquareUserRound, UserRound, Users, type LucideIcon } from 'lucide-react'
import { listTeams } from '@/app/actions/teams'
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarInput, SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar'
import { RAIL_ITEMS, type RailDestination } from '@/components/nav/icon-rail'
import { settingsItemVisible } from '@/lib/settings-sidebar-search'
import { settingsHref, visibleSettingsSections, type SettingsSectionId } from '@/lib/settings-sections'

const icons: Record<SettingsSectionId, LucideIcon> = {
  account: UserRound, security: Shield, preferences: SlidersHorizontal, notifications: Bell, memory: Brain, connections: Blocks,
  models: Gauge, logins: KeyRound, privacy: Lock, computers: Monitor, developer: SquareTerminal,
  general: Building2, members: Users, teams: SquareUserRound, bots: Bot, permissions: CircleCheck, secrets: HardDrive,
  audit: FileText, usage: ChartColumn, billing: CreditCard,
}

export function SettingsSidebar({ section, activeSection, admin, selectedTeamId, workspaceId, onSectionChange, onIntent, onRail }: {
  /** Unused: the account menu (and workspace switching) lives only behind the rail's avatar. */
  user?: unknown
  section: SettingsSectionId
  activeSection?: SettingsSectionId
  /** Viewer is a workspace admin. Admin-only sections stay hidden until this is known (S-P). */
  admin: boolean
  selectedTeamId?: string
  workspaceId?: string
  onSectionChange: (section: SettingsSectionId) => void
  /** A pointer or focus on an item: time to fetch its section. */
  onIntent?: (section: SettingsSectionId) => void
  onRail: (destination: RailDestination) => void
  /** Unused, as `user`. */
  onSignOut?: unknown
  signingOut?: unknown
}) {
  const i18nText = useTranslations();
  const [query, setQuery] = useState('')
  const params = useSearchParams()
  const creating = params.get('create') === '1'
  const { setOpenMobile, isMobile } = useSidebar()
  const { data: teams = [], error, mutate } = useSWR(activeSection ? 'teams' : null, listTeams)
  const contentRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    contentRef.current?.querySelector('[aria-current="page"]')?.closest('[data-slot="sidebar-group"]')?.scrollIntoView({ block: 'nearest' })
  }, [creating, section, selectedTeamId, teams.length])
  const normalizedQuery = query.trim().toLowerCase()
  const joinedTeams = teams.filter(team => team.role && (!workspaceId || team.workspaceId === workspaceId) && `${team.name} ${team.identifier}`.toLowerCase().includes(normalizedQuery))
  const href = (id: SettingsSectionId) => settingsHref(id, workspaceId)
  const body = <>
    <SidebarHeader className="px-3 pt-3 pb-2">
      <h2 className="flex h-8 items-center px-2 text-sm font-semibold">{i18nText("Settings.title")}</h2>
      <div className="relative mt-1"><Search className="pointer-events-none absolute top-2 left-2 size-4 text-muted-foreground" aria-hidden="true" /><SidebarInput className="pl-8" aria-label={i18nText("Settings.searchLabel")} placeholder={i18nText("Settings.searchPlaceholder")} value={query} onChange={event => setQuery(event.target.value)} /></div>
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
          return <SidebarMenuItem key={item.id}><SidebarMenuButton aria-label={label} render={activeSection ? <Link href={href(item.id)} /> : undefined} isActive={selected} aria-current={selected ? 'page' : undefined} onPointerEnter={() => onIntent?.(item.id)} onFocus={() => onIntent?.(item.id)} onClick={() => { if (!activeSection) onSectionChange(item.id); setOpenMobile(false) }}><Icon /><span>{label}</span></SidebarMenuButton></SidebarMenuItem>
        })}</SidebarMenu></SidebarGroup>
      })}
      {activeSection && <SidebarGroup className="py-2"><SidebarGroupLabel>{i18nText("Settings.groups.yourTeams")}</SidebarGroupLabel><SidebarMenu>{joinedTeams.map(team => {
        const selected = selectedTeamId === team.id
        const teamHref = `/settings/teams?workspace=${encodeURIComponent(team.workspaceId)}&team=${encodeURIComponent(team.id)}`
        return <SidebarMenuItem key={team.id}><SidebarMenuButton render={<Link href={teamHref} />} isActive={selected} aria-current={selected ? 'page' : undefined} onClick={() => setOpenMobile(false)}><SquareUserRound className="text-info" /><span>{team.name}</span></SidebarMenuButton></SidebarMenuItem>
      })}<SidebarMenuItem><SidebarMenuButton render={<Link href={`${href('teams')}&create=1`} />} aria-label={i18nText("FeatureCopy.c_cb11190c")} isActive={creating} aria-current={creating ? 'page' : undefined} onClick={() => setOpenMobile(false)}><Plus /><span>{i18nText("Settings.nav.createTeam")}</span></SidebarMenuButton></SidebarMenuItem>{error && <SidebarMenuItem><SidebarMenuButton onClick={() => void mutate()}>{i18nText("FeatureCopy.c_c401eee8")}</SidebarMenuButton></SidebarMenuItem>}</SidebarMenu></SidebarGroup>}
    </SidebarContent>
    {/* Phones have no rail; its destinations move here, as in the bot list. */}
    {isMobile && <SidebarFooter>
      <SidebarMenu>{RAIL_ITEMS.map(item => <SidebarMenuItem key={item.id}><SidebarMenuButton onClick={() => { setOpenMobile(false); onRail(item.id) }}><item.icon /><span>{i18nText(item.label)}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
    </SidebarFooter>}
  </>
  if (isMobile) return <Sidebar collapsible="offcanvas" mobileTitle={i18nText("Settings.title")} mobileCloseLabel={i18nText('Common.close')}>{body}</Sidebar>
  // On desktop the section list is the card's first column, where the bot list sits elsewhere in the app.
  return <div data-slot="settings-list" className="hidden shrink-0 border-r md:block">
    <Sidebar collapsible="none" aria-label={i18nText("FeatureCopy.c_a8c7ae4f")} className="w-64 bg-transparent">{body}</Sidebar>
  </div>
}
