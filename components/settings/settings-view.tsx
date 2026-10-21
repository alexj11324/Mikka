'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useTheme } from 'next-themes'
import { useTranslations } from 'next-intl'
import { ArrowLeft, Building2, Monitor, Moon, Search, SlidersHorizontal, Sun, UserRound } from 'lucide-react'
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarInput, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarRail, useSidebar } from '@/components/ui/sidebar'
import { AppShellContent } from '@/components/app-shell'
import { NavUser } from '@/components/nav-user'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { WorkspaceSettings } from '@/components/settings/workspace-settings'

type SectionId = 'preferences' | 'profile' | 'workspace'
type SectionGroup = 'personal' | 'workspace'

const SECTION_GROUPS: SectionGroup[] = ['personal', 'workspace']

const SECTIONS = [
  { id: 'preferences', group: 'personal', icon: SlidersHorizontal },
  { id: 'profile', group: 'personal', icon: UserRound },
  { id: 'workspace', group: 'workspace', icon: Building2 },
] as const

function SettingRow({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return <div className="flex flex-col gap-4 py-5 sm:flex-row sm:items-center sm:justify-between"><div className="flex flex-col gap-1"><div className="text-sm font-medium">{title}</div>{description && <p className="text-sm text-muted-foreground">{description}</p>}</div><div className="shrink-0 text-sm">{children}</div></div>
}

export function SettingsView({ user, onBack, onSignOut, signingOut, accountError }: { user: { name: string; email: string }; onBack: () => void; onSignOut: () => void; signingOut: boolean; accountError: string }) {
  const t = useTranslations('Settings')
  const navT = useTranslations('Nav')
  const commonT = useTranslations('Common')
  const [section, setSection] = useState<SectionId>('preferences')
  const [query, setQuery] = useState('')
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  const { setOpenMobile } = useSidebar()
  const sectionText: Record<SectionId, { title: string; description: string }> = {
    preferences: { title: t('sections.preferences.title'), description: t('sections.preferences.description') },
    profile: { title: t('sections.profile.title'), description: t('sections.profile.description') },
    workspace: { title: t('sections.workspace.title'), description: t('sections.workspace.description') },
  }
  const groupLabels: Record<SectionGroup, string> = {
    personal: t('groups.personal'),
    workspace: t('groups.workspace'),
  }
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
          return items.length > 0 && <SidebarGroup key={group}><SidebarGroupLabel>{groupLabels[group]}</SidebarGroupLabel><SidebarMenu>{items.map(item => <SidebarMenuItem key={item.id}><SidebarMenuButton isActive={section === item.id} aria-current={section === item.id ? 'page' : undefined} onClick={() => { setSection(item.id); setOpenMobile(false) }}><item.icon /><span>{item.title}</span></SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu></SidebarGroup>
        })}
        {filtered.length === 0 && <p className="px-4 py-2 text-sm text-muted-foreground" role="status">{t('noResults')}</p>}
      </SidebarContent>
      <SidebarFooter><NavUser user={user} onSignOut={onSignOut} signingOut={signingOut} /></SidebarFooter>
      <SidebarRail label={navT('toggleSidebar')} />
    </Sidebar>
    <AppShellContent parent={t('title')} title={current.title}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-9 px-6 py-10 sm:px-10 sm:py-16">
        <div className="flex flex-col gap-2"><h1 className="text-2xl font-semibold tracking-tight">{current.title}</h1><p className="text-sm text-muted-foreground">{current.description}</p></div>
        {accountError && <p role="alert" className="text-sm text-destructive">{accountError}</p>}
        {section === 'preferences' && <section className="flex flex-col gap-3" aria-labelledby="appearance-heading"><h2 id="appearance-heading" className="text-sm font-medium">{t('appearance.title')}</h2><div className="rounded-xl border bg-muted/30 px-5"><SettingRow title={t('appearance.theme')} description={t('appearance.themeDescription')}><ToggleGroup aria-label={t('appearance.themeLabel')} variant="outline" spacing={0} disabled={!mounted} value={mounted && theme ? [theme] : []} onValueChange={values => { if (values[0]) setTheme(values[0]) }}><ToggleGroupItem value="light" aria-label={t('appearance.light')}><Sun />{t('appearance.light')}</ToggleGroupItem><ToggleGroupItem value="dark" aria-label={t('appearance.dark')}><Moon />{t('appearance.dark')}</ToggleGroupItem><ToggleGroupItem value="system" aria-label={t('appearance.systemLabel')}><Monitor />{t('appearance.system')}</ToggleGroupItem></ToggleGroup></SettingRow><SettingRow title={t('appearance.language')} description={t('appearance.languageDescription')}><span className="text-muted-foreground">{t('appearance.languageName')}</span></SettingRow></div></section>}
        {section === 'profile' && <section className="flex flex-col gap-3" aria-labelledby="profile-heading"><h2 id="profile-heading" className="text-sm font-medium">{t('profile.heading')}</h2><div className="rounded-xl border bg-muted/30 px-5"><SettingRow title={t('profile.avatar')} description={t('profile.avatarDescription')}><Avatar className="size-10"><AvatarFallback>{(user.name || user.email).slice(0, 2).toUpperCase()}</AvatarFallback></Avatar></SettingRow><SettingRow title={t('profile.name')}><span>{user.name || t('profile.notSet')}</span></SettingRow><SettingRow title={t('profile.email')}><span className="break-all">{user.email}</span></SettingRow></div><p className="text-xs text-muted-foreground">{t('profile.readOnly')}</p></section>}
        {section === 'workspace' && <WorkspaceSettings />}
      </div>
    </AppShellContent>
  </>
}
