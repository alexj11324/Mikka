'use client'
import { useTranslations } from 'next-intl'

import { useEffect, useRef, useState } from 'react'
import { SettingsLink as Link } from './settings-link'
import { useSearchParams } from 'next/navigation'
import useSWR from 'swr'
import { Activity, ArrowLeft, ArrowLeftRight, Blocks, Building2, ChartNoAxesCombined, CodeXml, ContactRound, CreditCard, FileText, Flag, Grid2X2, HandHelping, Orbit, PackageCheck, Plus, Search, ShieldCheck, SlidersHorizontal, Smile, Sparkles, SquareUserRound, UserRound, Users } from 'lucide-react'
import { listTeams } from '@/app/actions/teams'
import { Sidebar, SidebarContent, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarInput, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarRail, useSidebar } from '@/components/ui/sidebar'
import { WorkspaceMenu } from '@/components/workspace-menu'
import { pushSettingsHistory } from '@/lib/settings-navigation'
import type { SettingsSection } from './settings-view'
import { useFeatureAvailability } from '@/hooks/use-feature-availability'

function GithubIcon() { return <img src="/icons/github.svg" alt="" className="size-4 shrink-0" /> }

const navigation = [
  { title: 'Personal', items: [
    { title: 'Preferences', section: 'preferences', icon: SlidersHorizontal },
    { title: 'Profile', section: 'profile', icon: UserRound },
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
    { title: 'Workspace', section: 'workspace', icon: Building2 },
    { title: 'Teams', section: 'teams', icon: SquareUserRound },
    { title: 'Members', section: 'members', icon: Users },
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
  function openSettings(href = '/settings') {
    const destination = new URL(href, window.location.origin)
    if (activeSection) {
      if (workspaceId) destination.searchParams.set('workspace', workspaceId)
      pushSettingsHistory(`${destination.pathname}${destination.search}`, workspaceId)
      return
    }
    const next = destination.pathname.endsWith('/members') ? 'members' : destination.searchParams.get('section')
    onSectionChange(next === 'profile' || next === 'workspace' || next === 'members' ? next : 'preferences')
  }
  return <Sidebar variant="sidebar" aria-label={i18nText("FeatureCopy.c_a8c7ae4f")}>
    <SidebarHeader className="px-4 pt-3 pb-2">
      <SidebarMenu><SidebarMenuItem><WorkspaceMenu user={user} onSettings={openSettings} onSignOut={onSignOut} signingOut={signingOut} /></SidebarMenuItem></SidebarMenu>
      <SidebarMenu><SidebarMenuItem><SidebarMenuButton aria-label={i18nText("Invite.backToWorkspace")} render={activeSection ? <Link href={selectedTeamId ? `/?team=${encodeURIComponent(selectedTeamId)}` : '/'} /> : undefined} onClick={() => { setOpenMobile(false); if (!activeSection) onBack() }}><ArrowLeft /><span lang="en">Back to app</span></SidebarMenuButton></SidebarMenuItem></SidebarMenu>
      <div className="relative mt-3"><Search className="pointer-events-none absolute top-2 left-2 size-4 text-muted-foreground" aria-hidden="true" /><SidebarInput className="pl-8" aria-label={i18nText("Settings.searchLabel")} placeholder="Search…" value={query} onChange={event => setQuery(event.target.value)} /></div>
    </SidebarHeader>
    <SidebarContent ref={contentRef} className="px-2 pb-6">
      {navigation.map(group => {
        const items = group.items.filter(item => {
          const label = 'section' in item ? i18nText(`Settings.sections.${item.section}.title` as never) : item.title
          return `${group.title} ${item.title} ${label}`.toLowerCase().includes(normalizedQuery) && (activeSection || !('section' in item) || (item.section !== 'teams' && item.section !== 'members'))
        })
        return items.length > 0 && <SidebarGroup key={group.title} className="py-2"><SidebarGroupLabel lang="en">{group.title}</SidebarGroupLabel><SidebarMenu>{items.map(item => {
          const id = 'section' in item ? item.section : undefined
          const label = id ? i18nText(`Settings.sections.${id}.title` as never) : item.title
          const selected = id === section && !selectedTeamId && !creating
          const release = id ? undefined : group.title === 'Features' ? productRelease : group.title === 'Integrations' ? integrationsRelease : administrationRelease
          return <SidebarMenuItem key={item.title}><SidebarMenuButton aria-label={label} disabled={!id || !!release && !release.enabled} data-feature-flag={release?.key} title={release?.reason} render={id && activeSection ? <Link href={href(id)} /> : undefined} isActive={selected} aria-current={selected ? 'page' : undefined} onClick={() => { if (id && !activeSection) onSectionChange(id); setOpenMobile(false) }}><item.icon /><span>{label}</span></SidebarMenuButton></SidebarMenuItem>
        })}</SidebarMenu></SidebarGroup>
      })}
      {activeSection && <SidebarGroup className="py-2"><SidebarGroupLabel lang="en">Your teams</SidebarGroupLabel><SidebarMenu>{joinedTeams.map(team => {
        const selected = selectedTeamId === team.id
        const teamHref = `/settings/teams?workspace=${encodeURIComponent(team.workspaceId)}&team=${encodeURIComponent(team.id)}`
        return <SidebarMenuItem key={team.id}><SidebarMenuButton render={<Link href={teamHref} />} isActive={selected} aria-current={selected ? 'page' : undefined} onClick={() => setOpenMobile(false)}><SquareUserRound className="text-info" /><span>{team.name}</span></SidebarMenuButton></SidebarMenuItem>
      })}<SidebarMenuItem><SidebarMenuButton render={<Link href={`${href('teams')}&create=1`} />} aria-label={i18nText("FeatureCopy.c_cb11190c")} isActive={creating} aria-current={creating ? 'page' : undefined} onClick={() => setOpenMobile(false)}><Plus /><span lang="en">Create a team</span></SidebarMenuButton></SidebarMenuItem>{error && <SidebarMenuItem><SidebarMenuButton onClick={() => void mutate()}>{i18nText("FeatureCopy.c_c401eee8")}</SidebarMenuButton></SidebarMenuItem>}</SidebarMenu></SidebarGroup>}
    </SidebarContent>
    <SidebarRail />
  </Sidebar>
}
