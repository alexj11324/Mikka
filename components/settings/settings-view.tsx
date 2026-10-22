'use client'

import { useEffect, useState } from 'react'
import { useTheme } from 'next-themes'
import { useTranslations } from 'next-intl'
import { ArrowLeft, Bot, Building2, Monitor, MonitorSmartphone, Moon, Search, SlidersHorizontal, SquarePen, Sun, UserRound, Users } from 'lucide-react'
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarInput, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarRail, useSidebar } from '@/components/ui/sidebar'
import { AppShellContent } from '@/components/app-shell'
import { Link } from '@/i18n/navigation'
import { cn } from '@/lib/utils'
import { NavUser } from '@/components/nav-user'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { WorkspaceSettings } from '@/components/settings/workspace-settings'
import { AgentsPanel } from '@/components/agents/agents-panel'
import { DevicesWorkspace } from '@/components/devices/devices-workspace'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'

export type SettingsSectionId = 'preferences' | 'profile' | 'agents' | 'workspace' | 'devices'
type SectionId = SettingsSectionId
type SectionGroup = 'personal' | 'workspace'

const SECTION_GROUPS: SectionGroup[] = ['personal', 'workspace']

const SECTIONS = [
  { id: 'preferences', group: 'personal', icon: SlidersHorizontal },
  { id: 'profile', group: 'personal', icon: UserRound },
  { id: 'agents', group: 'personal', icon: Bot },
  { id: 'workspace', group: 'workspace', icon: Building2 },
  { id: 'devices', group: 'workspace', icon: MonitorSmartphone },
] as const

const QUICK_LINKS = [
  { id: 'members', group: 'workspace', href: '/settings/members', icon: Users },
  { id: 'inviteMembers', group: 'workspace', href: '/settings/members?invite=1', icon: SquarePen },
] as const

export function SettingsView({ user, initialSection = 'preferences', onBack, onSignOut, signingOut, accountError }: { user: { id: string; name: string; email: string }; initialSection?: SettingsSectionId; onBack: () => void; onSignOut: () => void; signingOut: boolean; accountError: string }) {
  const t = useTranslations('Settings')
  const navT = useTranslations('Nav')
  const commonT = useTranslations('Common')
  const [section, setSection] = useState<SectionId>(initialSection)
  const [query, setQuery] = useState('')
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  const { setOpenMobile } = useSidebar()
  const sectionText: Record<SectionId, { title: string; description: string }> = {
    preferences: { title: t('sections.preferences.title'), description: t('sections.preferences.description') },
    profile: { title: t('sections.profile.title'), description: t('sections.profile.description') },
    agents: { title: t('sections.agents.title'), description: t('sections.agents.description') },
    workspace: { title: t('sections.workspace.title'), description: t('sections.workspace.description') },
    devices: { title: navT('devices'), description: t('sections.devices.description') },
  }
  const groupLabels: Record<SectionGroup, string> = {
    personal: t('groups.personal'),
    workspace: t('groups.workspace'),
  }
  const quickLinkText = {
    members: navT('members'),
    inviteMembers: navT('inviteMembers'),
  }
  const filteredLinks = QUICK_LINKS.filter(item => `${quickLinkText[item.id]} ${groupLabels[item.group]}`.includes(query.trim()))
  const sections = SECTIONS.map(item => ({ ...item, ...sectionText[item.id] }))
  const current = sections.find(item => item.id === section)!
  const filtered = sections.filter(item => `${item.title} ${groupLabels[item.group]}`.includes(query.trim()))
  return <>
    <Sidebar variant="inset" mobileTitle={navT('sidebarTitle')} mobileDescription={navT('sidebarDescription')} mobileCloseLabel={commonT('close')}>
      <SidebarHeader>
        <SidebarMenu><SidebarMenuItem><SidebarMenuButton onClick={() => { setOpenMobile(false); onBack() }}><ArrowLeft /><span>{t('backToApp')}</span></SidebarMenuButton></SidebarMenuItem></SidebarMenu>
        <div className="relative my-2"><Search className="pointer-events-none absolute top-2 left-2 size-4 text-muted-foreground" aria-hidden="true" /><SidebarInput className="pl-8" aria-label={t('searchLabel')} placeholder={t('searchPlaceholder')} value={query} onChange={event => setQuery(event.target.value)} /></div>
      </SidebarHeader>
      <SidebarContent>
        {SECTION_GROUPS.map(group => {
          const items = filtered.filter(item => item.group === group)
          const links = filteredLinks.filter(item => item.group === group)
          return (items.length > 0 || links.length > 0) && <SidebarGroup key={group}><SidebarGroupLabel>{groupLabels[group]}</SidebarGroupLabel><SidebarMenu>{items.map(item => <SidebarMenuItem key={item.id}><SidebarMenuButton isActive={section === item.id} aria-current={section === item.id ? 'page' : undefined} onClick={() => { setSection(item.id); setOpenMobile(false) }}><item.icon /><span>{item.title}</span></SidebarMenuButton></SidebarMenuItem>)}{links.map(item => <SidebarMenuItem key={item.id}><SidebarMenuButton render={<Link href={item.href} />}><item.icon /><span>{quickLinkText[item.id]}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></SidebarGroup>
        })}
        {filtered.length === 0 && filteredLinks.length === 0 && <p className="px-4 py-2 text-sm text-muted-foreground" role="status">{t('noResults')}</p>}
      </SidebarContent>
      <SidebarFooter><NavUser user={user} onSignOut={onSignOut} signingOut={signingOut} /></SidebarFooter>
      <SidebarRail label={navT('toggleSidebar')} />
    </Sidebar>
    <AppShellContent parent={t('title')} title={current.title}>
      <div className={cn('mx-auto flex w-full flex-col', section === 'agents' ? 'max-w-4xl gap-6 px-4 py-6 sm:px-6 xl:px-8' : 'max-w-3xl gap-9 px-6 py-10 sm:px-10 sm:py-16')}>
        <div className="flex flex-col gap-2"><h1 className="text-2xl font-semibold tracking-tight">{current.title}</h1><p className="text-sm text-muted-foreground">{current.description}</p></div>
        {accountError && <p role="alert" className="text-sm text-destructive">{accountError}</p>}
        {section === 'preferences' && <SettingsSection id="appearance-heading" title={t('appearance.title')}><SettingRow title={t('appearance.theme')} description={t('appearance.themeDescription')}><ToggleGroup aria-label={t('appearance.themeLabel')} variant="outline" spacing={0} disabled={!mounted} value={mounted && theme ? [theme] : []} onValueChange={values => { if (values[0]) setTheme(values[0]) }}><ToggleGroupItem value="light" aria-label={t('appearance.light')}><Sun />{t('appearance.light')}</ToggleGroupItem><ToggleGroupItem value="dark" aria-label={t('appearance.dark')}><Moon />{t('appearance.dark')}</ToggleGroupItem><ToggleGroupItem value="system" aria-label={t('appearance.systemLabel')}><Monitor />{t('appearance.system')}</ToggleGroupItem></ToggleGroup></SettingRow><SettingRow title={t('appearance.language')} description={t('appearance.languageDescription')}><span className="text-muted-foreground">{t('appearance.languageName')}</span></SettingRow></SettingsSection>}
        {section === 'profile' && <div className="flex flex-col gap-3"><SettingsSection id="profile-heading" title={t('profile.heading')}><SettingRow title={t('profile.avatar')} description={t('profile.avatarDescription')}><Avatar className="size-10"><AvatarFallback>{(user.name || user.email).slice(0, 2).toUpperCase()}</AvatarFallback></Avatar></SettingRow><SettingRow title={t('profile.name')}><span>{user.name || t('profile.notSet')}</span></SettingRow><SettingRow title={t('profile.email')}><span className="break-all">{user.email}</span></SettingRow></SettingsSection><p className="text-xs text-muted-foreground">{t('profile.readOnly')}</p></div>}
        {section === 'agents' && <AgentsPanel />}
        {section === 'workspace' && <WorkspaceSettings />}
        {section === 'devices' && <DevicesWorkspace user={user} localHostname="" initialDevices={[]} embedded />}
      </div>
    </AppShellContent>
  </>
}
