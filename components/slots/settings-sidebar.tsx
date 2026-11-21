'use client'
import { useLocale, useTranslations } from '@/lib/intl/i18n-client'

import { useLayoutEffect, useRef, useState } from 'react'
import { SettingsLink as Link } from '@/components/settings/settings-link'
import { useSearchParams } from '@/lib/client-runtime/navigation'
import useSWR from 'swr'
import { Bell, Blocks, Brain, Building2, ChartColumn, ChevronLeft, CircleCheck, CircleDashed, Cloud, CreditCard, FileText, Folder, Gauge, GitPullRequest, HardDrive, History, Keyboard, KeyRound, Landmark, Lightbulb, MessageSquareText, Monitor, Plus, Settings, Shield, ShieldCheck, SlidersHorizontal, SquareTerminal, SquareUserRound, Star, UserRound, Users, type IconGlyph } from '@/components/icons'
import { listTeams } from '@/app/actions/teams'
import { switchWorkspaceAndNavigate } from '@/hooks/use-workspace-switcher'
import { getPathname } from '@/i18n/navigation'
import { withBasePath } from '@/lib/base-path'
import { fetchSettingsData } from '@/lib/settings-data'
import type { WorkspaceSwitcher } from '@/lib/workspace-switcher'
import { Button } from '@/components/ui/button'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from '@/components/ui/sidebar'
import { SearchInput } from '@/components/ui/search-input'
import { RAIL_ITEMS } from '@/components/nav/icon-rail'
import { settingsItemVisible } from '@/lib/settings-sidebar-search'
import { SETTINGS_GROUPS, settingsHref, visibleSettingsSections, type SettingsGroup, type SettingsSectionId } from '@/lib/settings-sections'
import { ResizablePane } from '@/components/ui/resizable-pane'
import type { SettingsSidebarProps } from '@/components/slots/settings-sidebar-contract'

const icons = {
  preferences: Settings, appearance: SlidersHorizontal, account: UserRound, security: Shield, notifications: Bell,
  models: Gauge, environments: Folder, connections: Blocks, logins: KeyRound, developer: SquareTerminal, computers: Monitor,
  instructions: Brain, threads: MessageSquareText, shortcuts: Keyboard, git: GitPullRequest, 'review-repositories': Folder, 'review-config': CircleCheck, activity: History,
  general: Building2, 'issue-states': CircleDashed, members: Users, teams: SquareUserRound, permissions: ShieldCheck, secrets: HardDrive,
  audit: FileText, organization: Landmark, usage: ChartColumn, billing: CreditCard, cloud: Cloud,
  referrals: Star, experiments: Lightbulb, 'cloud-credentials': Cloud,
} satisfies Record<SettingsSectionId, IconGlyph>

const GROUP_TITLES = { personal: 'Personal', agent: 'Agent', review: 'Review', workspace: 'Workspace' } as const satisfies Record<SettingsGroup, string>

export function SettingsSidebar({ section, activeSection, admin, personal = false, billing = true, cloudAdmin = false, organization = false, workspaceName, selectedTeamId, workspaceId, onSectionChange, onIntent, onRail }: SettingsSidebarProps) {
  const i18nText = useTranslations();
  const [query, setQuery] = useState('')
  const params = useSearchParams()
  const creating = params.get('create') === '1'
  const { setOpenMobile, isMobile } = useSidebar()
  const { data: teams = [], error, mutate } = useSWR(activeSection ? 'teams' : null, listTeams)
  const contentRef = useRef<HTMLDivElement>(null)
  // The active item may appear only after Workspace kind and role resolve.
  // Recheck visibility changes before paint as well as route/team changes.
  useLayoutEffect(() => {
    contentRef.current?.querySelector('[aria-current="page"]')?.closest('[data-slot="sidebar-group"]')?.scrollIntoView({ block: 'nearest' })
  }, [creating, section, selectedTeamId, teams.length, personal, admin, billing, cloudAdmin, organization])
  const normalizedQuery = query.trim().toLowerCase()
  const joinedTeams = teams.filter(team => team.role && (!workspaceId || team.workspaceId === workspaceId) && `${team.name} ${team.identifier}`.toLowerCase().includes(normalizedQuery))
  const href = (id: SettingsSectionId) => settingsHref(id, workspaceId)
  const groups = SETTINGS_GROUPS.map(group => {
    const groupLabel = i18nText(`Settings.groups.${group}`)
    const items = visibleSettingsSections({ admin, personal, billing, cloudAdmin, organization }).filter(item => item.group === group && settingsItemVisible({
      query, groupTitle: GROUP_TITLES[group], groupLabel, itemTitle: item.title,
      label: i18nText.has(`Settings.sections.${item.id}.nav` as never) ? i18nText(`Settings.sections.${item.id}.nav` as never) : i18nText(`Settings.sections.${item.id}.title` as never),
      keywords: i18nText.has(`Settings.sections.${item.id}.keywords` as never) ? i18nText(`Settings.sections.${item.id}.keywords` as never) : '',
      section: item.id, routed: Boolean(activeSection),
    }))
    return { group, groupLabel, items }
  })
  // While searching, 你的团队 shows only for a team that matches; 创建团队 alone is not a result.
  // A personal workspace has no teams (decision 2026-11-01-2310).
  const showTeams = Boolean(activeSection) && !personal && (!normalizedQuery || joinedTeams.length > 0)
  const noMatch = Boolean(normalizedQuery) && !showTeams && groups.every(({ items }) => items.length === 0)
  const body = <>
    <SidebarHeader className="px-3 pt-3 pb-2">
      <Button type="button" variant="ghost" className="h-8 justify-start px-2 font-semibold" onClick={() => onRail('chats')}><ChevronLeft data-icon />{i18nText("Settings.title")}</Button>
      <SearchInput className="mt-1" aria-label={i18nText("Settings.searchLabel")} placeholder={i18nText("Settings.searchPlaceholder")} value={query} onChange={event => setQuery(event.target.value)} />
    </SidebarHeader>
    <SidebarContent ref={contentRef} className="px-2 pb-6">
      {noMatch && <p role="status" className="px-3 py-2 text-sm text-muted-foreground">{i18nText("Settings.searchEmpty")}</p>}
      {groups.map(({ group, groupLabel, items }) => {
        return items.length > 0 && <SidebarGroup key={group} className="py-2"><SidebarGroupLabel>{groupLabel}</SidebarGroupLabel><SidebarMenu>{items.map(item => {
          const Icon = icons[item.id]
          const label = i18nText.has(`Settings.sections.${item.id}.nav` as never) ? i18nText(`Settings.sections.${item.id}.nav` as never) : i18nText(`Settings.sections.${item.id}.title` as never)
          const selected = item.id === section && !selectedTeamId && !creating
          return <SidebarMenuItem key={item.id}><SidebarMenuButton className="data-active:bg-settings-nav-active data-active:text-object-chip-foreground data-active:hover:bg-settings-nav-active data-active:hover:text-object-chip-foreground" aria-label={label} render={activeSection ? <Link href={href(item.id)} /> : undefined} isActive={selected} aria-current={selected ? 'page' : undefined} onPointerEnter={() => onIntent?.(item.id)} onFocus={() => onIntent?.(item.id)} onClick={() => { if (!activeSection) onSectionChange(item.id); setOpenMobile(false) }}><Icon /><span>{label}</span></SidebarMenuButton></SidebarMenuItem>
        })}</SidebarMenu></SidebarGroup>
      })}
      {showTeams && <SidebarGroup className="py-2"><SidebarGroupLabel>{i18nText("Settings.groups.yourTeams")}</SidebarGroupLabel><SidebarMenu>{joinedTeams.map(team => {
        const selected = selectedTeamId === team.id
        const teamHref = `/settings/teams?workspace=${encodeURIComponent(team.workspaceId)}&team=${encodeURIComponent(team.id)}`
        return <SidebarMenuItem key={team.id}><SidebarMenuButton render={<Link href={teamHref} />} isActive={selected} aria-current={selected ? 'page' : undefined} onClick={() => setOpenMobile(false)}><SquareUserRound className="text-info" /><span>{team.name}</span></SidebarMenuButton></SidebarMenuItem>
      })}<SidebarMenuItem><SidebarMenuButton render={<Link href={`${href('teams')}&create=1`} />} aria-label={i18nText("FeatureCopy.c_cb11190c")} isActive={creating} aria-current={creating ? 'page' : undefined} onClick={() => setOpenMobile(false)}><Plus /><span>{i18nText("Settings.nav.createTeam")}</span></SidebarMenuButton></SidebarMenuItem>{error && <SidebarMenuItem><SidebarMenuButton onClick={() => void mutate()}>{i18nText("FeatureCopy.c_c401eee8")}</SidebarMenuButton></SidebarMenuItem>}</SidebarMenu></SidebarGroup>}
    </SidebarContent>
    {/* Phones have no rail; its destinations move here, as in the bot list. */}
    {workspaceId ? <WorkspaceSwitch currentId={workspaceId} currentName={workspaceName} section={section} /> : null}
    {isMobile && <SidebarFooter>
      <SidebarMenu>{RAIL_ITEMS.map(item => <SidebarMenuItem key={item.id}><SidebarMenuButton onClick={() => { setOpenMobile(false); onRail(item.id) }}><item.icon /><span>{i18nText(item.label)}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
    </SidebarFooter>}
  </>
  if (isMobile) return <Sidebar collapsible="offcanvas" mobileTitle={i18nText("Settings.title")} mobileCloseLabel={i18nText('Common.close')}>{body}</Sidebar>

  // On desktop the section list is the card's first column, where the bot list sits elsewhere in the app.
  return <ResizablePane data-slot="settings-list" storageKey="mikka:settings-list-width" defaultWidth={256} min={208} max={400} edge="end" from="md" label={i18nText('Common.resize.settingsList')} className="hidden shrink-0 border-r md:block">
    <Sidebar collapsible="none" aria-label={i18nText("FeatureCopy.c_a8c7ae4f")} className="w-full bg-transparent">{body}</Sidebar>
  </ResizablePane>
}

function WorkspaceSwitch({ currentId, currentName, section }: { currentId: string; currentName?: string; section: SettingsSectionId }) {
  const locale = useLocale()
  const t = useTranslations()
  const [pending, setPending] = useState(false)
  const { data } = useSWR('/api/workspace/switcher', fetchSettingsData<WorkspaceSwitcher>, { shouldRetryOnError: false })
  const choices = data?.accounts[0]?.choices ?? []
  async function select(workspaceId: string) {
    if (pending || workspaceId === currentId) return
    setPending(true)
    try {
      await switchWorkspaceAndNavigate({ workspaceId }, currentId,
        selected => withBasePath(getPathname({ locale, href: settingsHref(section, selected) })),
        t("FeatureCopy.c_b8e346ef"))
    } finally { setPending(false) }
  }
  if (choices.length < 2) return <p className="mt-auto border-t px-4 py-3 text-sm">{currentName}</p>
  return <div className="mt-auto flex items-center gap-2 px-3 py-2 text-sm">
    <Users />
    <NativeSelect aria-label={currentName} className="min-w-0 flex-1" value={currentId} disabled={pending} onChange={event => { void select(event.target.value) }}>
      {choices.map(choice => <NativeSelectOption key={choice.id} value={choice.id}>{choice.name}</NativeSelectOption>)}
    </NativeSelect>
  </div>
}
