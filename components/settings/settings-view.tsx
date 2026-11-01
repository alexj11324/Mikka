'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTheme } from 'next-themes'
import { useSWRConfig } from 'swr'
import { useTranslations } from 'next-intl'
import { Monitor, Moon, Sun } from 'lucide-react'
import { cn } from '@/lib/utils'
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
import { SubscriptionShareSettings } from '@/components/settings/subscription-share-settings'
import { ApiKeyFallbackSetting, useApiKeyList } from '@/components/settings/api-key-settings'
import { PaymentDesignationSettings } from '@/components/settings/payment-designation-settings'
import { GoogleSignInSettings } from '@/components/settings/google-sign-in-settings'
import { AccountSettings } from '@/components/settings/account-settings'
import { SecuritySettings } from '@/components/settings/security-settings'
import { PrivacySettings } from '@/components/settings/privacy-settings'
import { SavedLoginsSettings } from '@/components/settings/saved-logins-settings'
import { DevicesSettings } from '@/components/devices/devices-settings'
import { MemorySettings } from '@/components/settings/memory-settings'
import { LocaleSetting } from '@/components/settings/locale-setting'
import { NotificationSettings } from '@/components/settings/notifications-settings'
import { AccessTokensSettings } from '@/components/settings/access-tokens-settings'
import { E2BKeySettings, SecretsSettings } from '@/components/settings/secrets-settings'
import { AuditLogSettings } from '@/components/settings/audit-log-settings'
import { UsageSettings } from '@/components/settings/usage-settings'
import { BillingSettings } from '@/components/settings/billing-settings'
import { BotAgentsSettings } from '@/components/settings/bot-agents-settings'
import { ArchivedBotsSettings } from '@/components/settings/archived-bots-settings'
import { SettingRow, SettingsSection } from '@/components/settings/primitives'
import { useWorkspace } from '@/hooks/use-workspace'
import { settingsHref, TEAM_ONLY_SECTIONS, type SettingsSectionId } from '@/lib/settings-sections'
import { useRouter } from '@/i18n/navigation'
import type { RailDestination } from '@/components/nav/icon-rail'
import { prefetchAllSettings, prefetchSettingsSection } from '@/lib/settings-prefetch'
import { FieldError } from '@/components/ui/field'

export type { SettingsSectionId as SettingsSection } from '@/lib/settings-sections'

interface SettingsViewProps {
  user: { name: string; email: string; image?: string | null }
  userKey?: string
  googleEnabled?: boolean
  /** Leaves Settings for a rail destination; phones, which have no rail, list them in the section sheet. */
  onRail: (destination: RailDestination) => void
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

export function SettingsView({ user, userKey, googleEnabled = false, onRail, onSignOut, signingOut, accountError, activeSection, initialSection, inviteInitially = false, workspaceId, selectedTeamId, children, linearNotice = null, preview = false }: SettingsViewProps) {
  const t = useTranslations('Settings')
  const [localSection, setSection] = useState<SettingsSectionId>(activeSection ?? initialSection ?? 'preferences')
  const section = activeSection ?? localSection
  const { data: workspace, error: workspaceError } = useWorkspace(userKey ?? user.email, workspaceId)
  const admin = workspace?.role === 'admin'
  const personal = workspace?.workspace.kind === 'personal'
  const router = useRouter()
  // A personal workspace has no member pages; an old link to one opens 常规 instead.
  const teamOnly = personal && TEAM_ONLY_SECTIONS.has(activeSection ?? localSection)
  useEffect(() => {
    if (!teamOnly) return
    if (activeSection) router.replace(settingsHref('general', workspaceId ?? workspace?.workspace.id))
    else setSection('general')
  }, [teamOnly, activeSection, router, workspaceId, workspace?.workspace.id])
  const { cache } = useSWRConfig()
  // Settings opened without ?workspace= still has one: the default the API resolved.
  const resolvedWorkspaceId = workspaceId ?? workspace?.workspace.id
  const roleKnown = workspace !== undefined
  // Once the role is known, load every section the viewer can open, so none shows a skeleton later.
  useEffect(() => {
    if (preview || !roleKnown || !resolvedWorkspaceId) return
    return prefetchAllSettings(resolvedWorkspaceId, admin, cache)
  }, [preview, roleKnown, resolvedWorkspaceId, admin, cache])
  const title = t(`sections.${section}.title`)
  const routedBody = section === 'members' || section === 'teams'
  // Switching sections fades the new one in briefly; the section the page opened on does not (docs/design/decisions/2026-10-31-1814-segmented-control-motion.md).
  const firstSection = useRef(section)
  const switched = useRef(false)
  if (section !== firstSection.current) switched.current = true
  const enter = switched.current ? 'animate-in fade-in-0 duration-150 motion-reduce:animate-none' : undefined

  return <>
    <SettingsSidebar section={section} activeSection={activeSection} admin={admin} personal={personal} workspaceName={workspace?.workspace.name} selectedTeamId={selectedTeamId} workspaceId={workspaceId} onSectionChange={setSection} onIntent={next => { if (!preview) prefetchSettingsSection(next, resolvedWorkspaceId, cache) }} onRail={onRail} />
    <AppShellContent parent={t('title')} title={title} variant="settings">
      {accountError && <FieldError className="px-6 py-2">{accountError}</FieldError>}
      {routedBody ? section === 'members' ? <SettingsContent className="gap-6">{children ?? <MembersPanel workspaceId={workspaceId} inviteInitially={inviteInitially} />}</SettingsContent> : children : <SettingsContent key={section} className={cn('gap-6', enter)}>
        {section === 'computers' ? <DevicesSettings /> : <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>}
        <SectionBody t={t} section={section} user={user} userKey={userKey} googleEnabled={googleEnabled} workspaceId={resolvedWorkspaceId} workspaceError={Boolean(workspaceError) || (workspace !== undefined && !resolvedWorkspaceId)} linearNotice={linearNotice} preview={preview} onSignOut={onSignOut} signingOut={signingOut} />
      </SettingsContent>}
    </AppShellContent>
  </>
}

function SectionBody({ t, section, user, userKey, googleEnabled, workspaceId, workspaceError = false, linearNotice, preview, onSignOut, signingOut }: { t: ReturnType<typeof useTranslations<'Settings'>> } & Pick<SettingsViewProps, 'user' | 'userKey' | 'workspaceId' | 'linearNotice' | 'preview' | 'onSignOut' | 'signingOut'> & { section: SettingsSectionId; googleEnabled: boolean; workspaceError?: boolean }) {
  // Workspace sections wait for the workspace instead of rendering nothing.
  const waiting = preview || !workspaceId
    ? preview || workspaceError ? <FieldError>{t('workspaceUnavailable')}</FieldError> : <p role="status" className="text-sm text-muted-foreground">{t('workspaceLoading')}</p>
    : null
  switch (section) {
    case 'account': return <AccountSettings user={user} onSignOut={onSignOut} signingOut={signingOut} />
    case 'security': return <><SecuritySettings /><GoogleSignInSettings googleEnabled={googleEnabled} /></>
    case 'privacy': return <PrivacySettings />
    case 'logins': return <SavedLoginsSettings />
    case 'preferences': return <><AppearanceSection /><IssuePrefixSettings /></>
    case 'notifications': return <NotificationSettings />
    case 'memory': return <MemorySettings />
    case 'connections': return <PluginsView section="connections" rootLabel={t('sections.connections.title')} linearNotice={linearNotice} />
    case 'models': return <>{workspaceId && !preview ? <ApiAndSubscriptions key={workspaceId} workspaceId={workspaceId} /> : waiting}</>
    case 'developer': return workspaceId && !preview ? <AccessTokensSettings key={workspaceId} workspaceId={workspaceId} /> : waiting
    case 'secrets': return workspaceId && !preview ? <SecretsSettings key={workspaceId} workspaceId={workspaceId} /> : waiting
    case 'audit': return workspaceId && !preview ? <AuditLogSettings key={workspaceId} workspaceId={workspaceId} /> : waiting
    case 'usage': return workspaceId && !preview ? <UsageSettings key={workspaceId} workspaceId={workspaceId} /> : waiting
    case 'billing': return workspaceId && !preview ? <><PaymentDesignationSettings key={`payment-${workspaceId}`} workspaceId={workspaceId} /><BillingSettings key={workspaceId} workspaceId={workspaceId} /></> : waiting
    case 'general': return <WorkspaceSettings userKey={userKey ?? user.email} workspaceId={workspaceId} />
    case 'computers': return null
    case 'bots': return workspaceId && !preview ? <><BotAgentsSettings key={workspaceId} /><ArchivedBotsSettings key={`archived-${workspaceId}`} workspaceId={workspaceId} /></> : waiting
    case 'permissions': return workspaceId && !preview ? <TeamPermissionsSettings key={workspaceId} workspaceId={workspaceId} /> : waiting
    default: return null
  }
}

/** 「API 与订阅」: subscriptions, API keys and custom providers in one list (orchestration.md § 1). */
function ApiAndSubscriptions({ workspaceId }: { workspaceId: string }) {
  const apiKeys = useApiKeyList(workspaceId)
  return <>
    <SubscriptionSettings workspaceId={workspaceId} extraRows={apiKeys.rows} action={apiKeys.action} />
    {apiKeys.dialogs}
    <ApiKeyFallbackSetting workspaceId={workspaceId} />
    {/* The person's own E2B key: account-level, so before this workspace's settings. */}
    <E2BKeySettings key={`e2b-${workspaceId}`} workspaceId={workspaceId} />
    <SubscriptionShareSettings key={`share-${workspaceId}`} workspaceId={workspaceId} />
    <PaymentDesignationSettings key={`payment-${workspaceId}`} workspaceId={workspaceId} />
  </>
}

function AppearanceSection() {
  const t = useTranslations('Settings.appearance')
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  return <SettingsSection id="appearance-heading" title={t('title')}>
    <SettingRow title={t('theme')}>
      <ToggleGroup aria-label={t('themeLabel')} variant="segment" spacing={0.5} disabled={!mounted} value={mounted && theme ? [theme] : []} onValueChange={values => { if (values[0]) setTheme(values[0]) }}>
        <ToggleGroupItem value="light" aria-label={t('light')}><Sun />{t('light')}</ToggleGroupItem>
        <ToggleGroupItem value="dark" aria-label={t('dark')}><Moon />{t('dark')}</ToggleGroupItem>
        <ToggleGroupItem value="system" aria-label={t('systemLabel')}><Monitor />{t('system')}</ToggleGroupItem>
      </ToggleGroup>
    </SettingRow>
    <SettingRow title={t('language')}><LocaleSetting /></SettingRow>
  </SettingsSection>
}
