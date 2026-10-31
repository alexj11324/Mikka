'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { useTheme } from 'next-themes'
import { useTranslations } from 'next-intl'
import { Monitor, Moon, Sun } from 'lucide-react'
import { AppShellContent } from '@/components/app-shell'
import { SettingsContent } from '@/components/ui/settings-layout'
import { SettingsSidebar } from './settings-sidebar'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { WorkspaceSettings } from '@/components/settings/workspace-settings'
import { MembersPanel } from '@/components/settings/members-panel'
import { IssuePrefixSettings } from '@/components/settings/issue-prefix-settings'
import { PluginsView } from '@/components/plugins/plugins-view'
import { TeamPermissionsSettings } from '@/components/settings/team-permissions-settings'
import { SubscriptionSettings } from '@/components/settings/subscription-settings'
import { GoogleSignInSettings } from '@/components/settings/google-sign-in-settings'
import { AccountSettings } from '@/components/settings/account-settings'
import { SecuritySettings } from '@/components/settings/security-settings'
import { PrivacySettings } from '@/components/settings/privacy-settings'
import { ActivitySettings } from '@/components/settings/activity-settings'
import { SavedLoginsSettings } from '@/components/settings/saved-logins-settings'
import { DevicesSettings } from '@/components/devices/devices-settings'
import { MemorySettings } from '@/components/settings/memory-settings'
import { LocaleSetting } from '@/components/settings/locale-setting'
import { NotificationSettings } from '@/components/settings/notifications-settings'
import { AccessTokensSettings } from '@/components/settings/access-tokens-settings'
import { SecretsSettings } from '@/components/settings/secrets-settings'
import { AuditLogSettings } from '@/components/settings/audit-log-settings'
import { UsageSettings } from '@/components/settings/usage-settings'
import { BillingSettings } from '@/components/settings/billing-settings'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { useWorkspace } from '@/hooks/use-workspace'
import type { SettingsSectionId } from '@/lib/settings-sections'

export type { SettingsSectionId as SettingsSection } from '@/lib/settings-sections'

interface SettingsViewProps {
  user: { name: string; email: string; image?: string | null }
  userKey?: string
  googleEnabled?: boolean
  onBack: () => void
  onSignOut: () => void
  signingOut: boolean
  accountError: string
  activeSection?: SettingsSectionId
  initialSection?: SettingsSectionId
  inviteInitially?: boolean
  workspaceId?: string
  selectedTeamId?: string
  children?: ReactNode
  linearNotice?: 'connected' | 'error' | null
  preview?: boolean
}

export function SettingsView({ user, userKey, googleEnabled = false, onBack, onSignOut, signingOut, accountError, activeSection, initialSection, inviteInitially = false, workspaceId, selectedTeamId, children, linearNotice = null, preview = false }: SettingsViewProps) {
  const t = useTranslations('Settings')
  const [localSection, setSection] = useState<SettingsSectionId>(activeSection ?? initialSection ?? 'preferences')
  const section = activeSection ?? localSection
  const { data: workspace, error: workspaceError } = useWorkspace(userKey ?? user.email, workspaceId)
  const admin = workspace?.role === 'admin'
  // Settings opened without ?workspace= still has one: the default the API resolved.
  const resolvedWorkspaceId = workspaceId ?? workspace?.workspace.id
  const title = t(`sections.${section}.title`)
  const routedBody = section === 'members' || section === 'teams'

  return <>
    <SettingsSidebar user={user} section={section} activeSection={activeSection} admin={admin} selectedTeamId={selectedTeamId} workspaceId={workspaceId} onSectionChange={setSection} onBack={onBack} onSignOut={onSignOut} signingOut={signingOut} />
    <AppShellContent parent={t('title')} title={title} variant="settings">
      {accountError && <p role="alert" className="px-6 py-2 text-sm text-destructive">{accountError}</p>}
      {routedBody ? section === 'members' ? <SettingsContent className="gap-6">{children ?? <MembersPanel workspaceId={workspaceId} inviteInitially={inviteInitially} />}</SettingsContent> : children : <SettingsContent className="gap-6">
        {section === 'computers' ? <DevicesSettings /> : <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>}
        <SectionBody t={t} section={section} user={user} userKey={userKey} googleEnabled={googleEnabled} workspaceId={resolvedWorkspaceId} workspaceError={Boolean(workspaceError) || (workspace !== undefined && !resolvedWorkspaceId)} linearNotice={linearNotice} preview={preview} onSignOut={onSignOut} signingOut={signingOut} />
      </SettingsContent>}
    </AppShellContent>
  </>
}

function SectionBody({ t, section, user, userKey, googleEnabled, workspaceId, workspaceError = false, linearNotice, preview, onSignOut, signingOut }: { t: ReturnType<typeof useTranslations<'Settings'>> } & Pick<SettingsViewProps, 'user' | 'userKey' | 'workspaceId' | 'linearNotice' | 'preview' | 'onSignOut' | 'signingOut'> & { section: SettingsSectionId; googleEnabled: boolean; workspaceError?: boolean }) {
  // Workspace sections wait for the workspace instead of rendering nothing.
  const waiting = preview || !workspaceId
    ? preview || workspaceError ? <p role="alert" className="text-sm text-destructive">{t('workspaceUnavailable')}</p> : <p role="status" className="text-sm text-muted-foreground">{t('workspaceLoading')}</p>
    : null
  switch (section) {
    case 'account': return <AccountSettings user={user} onSignOut={onSignOut} signingOut={signingOut} />
    case 'security': return <><SecuritySettings /><GoogleSignInSettings googleEnabled={googleEnabled} /></>
    case 'privacy': return <PrivacySettings />
    case 'activity': return <ActivitySettings />
    case 'logins': return <SavedLoginsSettings />
    case 'preferences': return <><AppearanceSection /><IssuePrefixSettings /></>
    case 'notifications': return <NotificationSettings />
    case 'memory': return <MemorySettings />
    case 'connections': return <PluginsView section="connections" rootLabel={t('sections.connections.title')} linearNotice={linearNotice} />
    case 'models': return workspaceId && !preview ? <SubscriptionSettings key={workspaceId} workspaceId={workspaceId} /> : waiting
    case 'developer': return workspaceId && !preview ? <AccessTokensSettings key={workspaceId} workspaceId={workspaceId} /> : waiting
    case 'secrets': return workspaceId && !preview ? <SecretsSettings key={workspaceId} workspaceId={workspaceId} /> : waiting
    case 'audit': return workspaceId && !preview ? <AuditLogSettings key={workspaceId} workspaceId={workspaceId} /> : waiting
    case 'usage': return workspaceId && !preview ? <UsageSettings key={workspaceId} workspaceId={workspaceId} /> : waiting
    case 'billing': return workspaceId && !preview ? <BillingSettings key={workspaceId} workspaceId={workspaceId} /> : waiting
    case 'general': return <WorkspaceSettings userKey={userKey ?? user.email} workspaceId={workspaceId} />
    case 'permissions': return workspaceId && !preview ? <TeamPermissionsSettings key={workspaceId} workspaceId={workspaceId} /> : waiting
    default: return <p className="py-8 text-sm text-muted-foreground">{t('sectionUnavailable')}</p>
  }
}

function AppearanceSection() {
  const t = useTranslations('Settings.appearance')
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  return <SettingsSection id="appearance-heading" title={t('title')}>
    <SettingRow title={t('theme')} description={t('themeDescription')}>
      <ToggleGroup aria-label={t('themeLabel')} variant="outline" spacing={0} disabled={!mounted} value={mounted && theme ? [theme] : []} onValueChange={values => { if (values[0]) setTheme(values[0]) }}>
        <ToggleGroupItem value="light" aria-label={t('light')}><Sun />{t('light')}</ToggleGroupItem>
        <ToggleGroupItem value="dark" aria-label={t('dark')}><Moon />{t('dark')}</ToggleGroupItem>
        <ToggleGroupItem value="system" aria-label={t('systemLabel')}><Monitor />{t('system')}</ToggleGroupItem>
      </ToggleGroup>
    </SettingRow>
    <SettingRow title={t('language')} description={t('languageDescription')}><LocaleSetting /></SettingRow>
  </SettingsSection>
}
