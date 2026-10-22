'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useTheme } from 'next-themes'
import { useTranslations } from 'next-intl'
import { Monitor, Moon, Sun } from 'lucide-react'
import { AppShellContent } from '@/components/app-shell'
import { SettingsSidebar } from './settings-sidebar'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { WorkspaceSettings } from '@/components/settings/workspace-settings'
import { SettingRow, SettingsSection as SettingsSectionComponent } from '@/components/settings/primitives'

const sections = ['preferences', 'profile', 'workspace', 'teams', 'members'] as const
export type SettingsSection = (typeof sections)[number]

export function SettingsView({ user, onBack, onSignOut, signingOut, accountError, activeSection, workspaceId, selectedTeamId, children }: { user: { name: string; email: string; image?: string | null }; onBack: () => void; onSignOut: () => void; signingOut: boolean; accountError: string; activeSection?: SettingsSection; workspaceId?: string; selectedTeamId?: string; children?: ReactNode }) {
  const t = useTranslations('Settings')
  const [localSection, setSection] = useState<SettingsSection>('preferences')
  const section = activeSection ?? localSection
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  const title = t(`sections.${section}.title`)
  const description = t(`sections.${section}.description`)

  return <>
    <SettingsSidebar user={user} section={section} activeSection={activeSection} selectedTeamId={selectedTeamId} workspaceId={workspaceId} onSectionChange={setSection} onBack={onBack} onSignOut={onSignOut} signingOut={signingOut} />
    <AppShellContent parent={t('title')} title={title} variant="settings">
      {accountError && <p role="alert" className="px-6 py-2 text-sm text-destructive">{accountError}</p>}
      {section === 'members' || section === 'teams' ? children : <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2"><h1 className="text-2xl font-semibold tracking-tight">{title}</h1><p className="text-sm text-muted-foreground">{description}</p></div>
        {section === 'preferences' && <SettingsSectionComponent id="appearance-heading" title={t('appearance.title')}><SettingRow title={t('appearance.theme')} description={t('appearance.themeDescription')}><ToggleGroup aria-label={t('appearance.themeLabel')} variant="outline" spacing={0} disabled={!mounted} value={mounted && theme ? [theme] : []} onValueChange={values => { if (values[0]) setTheme(values[0]) }}><ToggleGroupItem value="light" aria-label={t('appearance.light')}><Sun />{t('appearance.light')}</ToggleGroupItem><ToggleGroupItem value="dark" aria-label={t('appearance.dark')}><Moon />{t('appearance.dark')}</ToggleGroupItem><ToggleGroupItem value="system" aria-label={t('appearance.systemLabel')}><Monitor />{t('appearance.system')}</ToggleGroupItem></ToggleGroup></SettingRow><SettingRow title={t('appearance.language')} description={t('appearance.languageDescription')}><span className="text-muted-foreground">{t('appearance.languageName')}</span></SettingRow></SettingsSectionComponent>}
        {section === 'profile' && <div className="flex flex-col gap-3"><SettingsSectionComponent id="profile-heading" title={t('profile.heading')}><SettingRow title={t('profile.avatar')} description={t('profile.avatarDescription')}><Avatar className="size-10"><AvatarFallback>{(user.name || user.email).slice(0, 2).toUpperCase()}</AvatarFallback></Avatar></SettingRow><SettingRow title={t('profile.name')}><span>{user.name || t('profile.notSet')}</span></SettingRow><SettingRow title={t('profile.email')}><span className="break-all">{user.email}</span></SettingRow></SettingsSectionComponent><p className="text-xs text-muted-foreground">{t('profile.readOnly')}</p></div>}
        {section === 'workspace' && <WorkspaceSettings />}
      </div>}
    </AppShellContent>
  </>
}
