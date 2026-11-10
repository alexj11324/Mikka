'use client'

import { BotPermissionsSettings } from './bot-permissions'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useSWRConfig } from 'swr'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { SettingsContentFrame } from '@ui-slot/settings-content'
import { ApiAndSubscriptions } from '@ui-slot/settings-models'
import { SecurityAndSignIn } from '@ui-slot/settings-security'
import { PreferencesSettings } from '@ui-slot/settings-preferences'
import { WorkspaceGeneral } from '@ui-slot/settings-general'
import * as membersSlot from '@ui-slot/settings-members'
import { SettingsContent } from '@/components/ui/settings-layout'
import { SettingsSidebar } from './settings-sidebar'
import { MembersPanel } from '@/components/settings/members-panel'
import { PluginsView } from '@/components/plugins/plugins-view'
import { TeamPermissionsSettings } from '@/components/settings/team-permissions-settings'
import { PaymentDesignationSettings } from '@/components/settings/payment-designation-settings'
import { AccountSettings } from '@/components/settings/account-settings'
import { CloudSettings } from '@/components/settings/cloud-settings'

import { PrivacySettings } from '@/components/settings/privacy-settings'
import { SecretsPage } from '@/components/settings/secrets-page'
import { DevicesSettings } from '@/components/devices/devices-settings'
import { MemorySettings } from '@/components/settings/memory-settings'
import { NotificationSettings } from '@/components/settings/notifications-settings'
import { AccessTokensSettings } from '@/components/settings/access-tokens-settings'
import { AuditLogSettings } from '@/components/settings/audit-log-settings'
import { UsageSettings } from '@/components/settings/usage-settings'
import { BillingSettings } from '@/components/settings/billing-settings'
import { useWorkspace } from '@/hooks/use-workspace'
import { settingsHref, TEAM_ONLY_SECTIONS, type SettingsSectionId } from '@/lib/settings-sections'
import { useRouter } from '@/i18n/navigation'
import { pushSettingsHistory } from '@/lib/settings-navigation'
import type { RailDestination } from '@/components/nav/icon-rail'
import { prefetchSettingsSection } from '@/lib/settings-prefetch'
import { FieldError } from '@/components/ui/field'
import { toast } from 'sonner'

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
  const { data: workspace, error: workspaceError } = useWorkspace(userKey ?? user.email, workspaceId)
  const requestedSection = activeSection ?? localSection
  const billing = workspace !== undefined && workspace.edition !== 'community'
  const community = workspace?.edition === 'community'
  const cloudAdmin = community && workspace?.serverAdmin === true
  const section = (requestedSection === 'billing' && !billing) || (requestedSection === 'cloud' && !cloudAdmin) ? 'preferences' : requestedSection
  const admin = workspace?.role === 'admin'
  const personal = workspace?.workspace.kind === 'personal'
  // Team settings show once the workspace is known to be a team, as admin-only ones wait for the role.
  const team = workspace !== undefined && !personal
  const router = useRouter()
  // A personal workspace has no team settings (decision 2026-11-01-2310); an old link to one opens 偏好设置 instead.
  const teamOnly = personal && TEAM_ONLY_SECTIONS.has(requestedSection)
  const unavailableBilling = workspace?.edition === 'community' && requestedSection === 'billing'
  useEffect(() => {
    if (!teamOnly && !unavailableBilling) return
    // Say why the page asked for is not the one shown (UI audit settings2-06); one toast, however often the effect runs.
    if (teamOnly) toast(t('teamOnlyNotice'), { id: 'settings-team-only' })
    if (activeSection) router.replace(settingsHref('preferences', workspaceId ?? workspace?.workspace.id))
    else setSection('preferences')
  }, [teamOnly, unavailableBilling, activeSection, router, workspaceId, workspace?.workspace.id, t])
  const { cache, mutate } = useSWRConfig()
  // Settings opened without ?workspace= still has one: the default the API resolved.
  const resolvedWorkspaceId = workspaceId ?? workspace?.workspace.id
  const roleKnown = workspace !== undefined
  // Read only the open section. Pointer/focus intent warms the next section.
  useEffect(() => {
    if (preview || !roleKnown || !resolvedWorkspaceId) return
    prefetchSettingsSection(section, resolvedWorkspaceId, cache, mutate)
  }, [preview, roleKnown, resolvedWorkspaceId, section, cache, mutate])
  const title = t(`sections.${section}.title`)
  const routedBody = section === 'members' || section === 'teams'
  // A UI layer may draw 成员 and 团队 as one page with two tabs (slot settings-members); otherwise each keeps its own.
  const MembersScreen = membersSlot.MembersScreen ?? null
  const LayerMembers = MembersScreen && routedBody && !preview ? MembersScreen : null
  const openSection = (next: SettingsSectionId) => {
    const href = settingsHref(next, workspaceId)
    if (!activeSection) setSection(next)
    else if (!pushSettingsHistory(href, workspaceId)) router.push(href)
  }
  // Switching sections fades the new one in briefly; the section the page opened on does not (docs/design/decisions/2026-10-31-1814-segmented-control-motion.md).
  const firstSection = useRef(section)
  const switched = useRef(false)
  if (section !== firstSection.current) switched.current = true
  const enter = switched.current ? 'animate-in fade-in-0 duration-150 motion-reduce:animate-none' : undefined

  return <>
    <SettingsSidebar section={section} activeSection={activeSection} admin={admin} personal={!team} billing={billing} cloudAdmin={cloudAdmin} workspaceName={workspace?.workspace.name} selectedTeamId={selectedTeamId} workspaceId={workspaceId} onSectionChange={setSection} onIntent={next => { if (!preview && (next !== 'billing' || billing)) prefetchSettingsSection(next, resolvedWorkspaceId, cache, mutate) }} onRail={onRail} />
    <SettingsContentFrame parent={t('title')} title={title}>

      {accountError && <FieldError className="px-6 py-2">{accountError}</FieldError>}
      {LayerMembers ? <SettingsContent className="gap-6 max-md:pt-1">{team && resolvedWorkspaceId ? <LayerMembers key={resolvedWorkspaceId} section={section === 'teams' ? 'teams' : 'members'} workspaceId={resolvedWorkspaceId} inviteInitially={inviteInitially} onSection={openSection} /> : workspaceError ? <FieldError>{t('workspaceUnavailable')}</FieldError> : <p role="status" className="text-sm text-muted-foreground">{t('workspaceLoading')}</p>}</SettingsContent> : routedBody ? section === 'members' ? <SettingsContent className="gap-6 max-md:pt-1">{children ?? <MembersPanel workspaceId={workspaceId} inviteInitially={inviteInitially} />}</SettingsContent> : children : <SettingsContent key={section} className={cn('gap-6 max-md:pt-1', enter)}>
        {section === 'computers' ? <DevicesSettings workspaceId={resolvedWorkspaceId} /> : <h1 className="text-xl font-semibold max-md:sr-only">{title}</h1>}
        <SectionBody t={t} section={section} user={user} userKey={userKey} googleEnabled={googleEnabled} workspaceId={resolvedWorkspaceId} workspaceName={workspace?.workspace.name} personal={personal} team={team} admin={admin} community={community} workspaceError={Boolean(workspaceError) || (workspace !== undefined && !resolvedWorkspaceId)} linearNotice={linearNotice} preview={preview} onSignOut={onSignOut} signingOut={signingOut} onSection={next => { if (!activeSection || !pushSettingsHistory(settingsHref(next, workspaceId), workspaceId)) setSection(next) }} />
      </SettingsContent>}
    </SettingsContentFrame>
  </>
}

function SectionBody({ t, section, user, userKey, googleEnabled, workspaceId, workspaceName, personal = false, team = false, admin = false, community = false, workspaceError = false, linearNotice, preview, onSignOut, signingOut, onSection }: { t: ReturnType<typeof useTranslations<'Settings'>> } & Pick<SettingsViewProps, 'user' | 'userKey' | 'workspaceId' | 'linearNotice' | 'preview' | 'onSignOut' | 'signingOut'> & { section: SettingsSectionId; googleEnabled: boolean; workspaceName?: string; personal?: boolean; team?: boolean; admin?: boolean; community?: boolean; workspaceError?: boolean; onSection: (section: SettingsSectionId) => void }) {
  // Workspace sections wait for the workspace instead of rendering nothing.
  const waiting = preview || !workspaceId
    ? preview || workspaceError ? <FieldError>{t('workspaceUnavailable')}</FieldError> : <p role="status" className="text-sm text-muted-foreground">{t('workspaceLoading')}</p>
    : null
  switch (section) {
    case 'account': return <><AccountSettings user={user} onSignOut={onSignOut} signingOut={signingOut} />{community && userKey && <CloudSettings personal userKey={userKey} workspaceId={workspaceId} />}</>
    case 'cloud': return userKey ? <CloudSettings userKey={userKey} workspaceId={workspaceId} /> : null
    case 'security': return <SecurityAndSignIn googleEnabled={googleEnabled} />

    case 'privacy': return <PrivacySettings />
    case 'logins':
    case 'secrets': return <SecretsPage side={section === 'logins' ? 'mine' : 'workspace'} onSide={side => onSection(side === 'mine' ? 'logins' : 'secrets')} workspaceId={workspaceId && !preview ? workspaceId : undefined} workspaceName={workspaceName} waiting={waiting} />
    case 'preferences': return <PreferencesSettings />
    case 'notifications': return <NotificationSettings />
    case 'memory': return <MemorySettings />
    case 'bot-permissions': return <BotPermissionsSettings admin={admin} />
    case 'connections': return <PluginsView section="connections" rootLabel={t('sections.connections.title')} linearNotice={linearNotice} workspaceId={!preview ? workspaceId : undefined} workspaceName={workspaceName} />
    case 'models': return <>{workspaceId && !preview ? <ApiAndSubscriptions key={workspaceId} workspaceId={workspaceId} workspaceName={workspaceName} team={team} cloudUserKey={community ? userKey : undefined} /> : waiting}</>
    case 'developer': return workspaceId && !preview ? <AccessTokensSettings key={workspaceId} workspaceId={workspaceId} /> : waiting
    // Admins only, as its read: anyone else (a link, a bookmark, a workspace where they are a member) is told so, and nothing is read.
    case 'audit': return workspaceId && !preview && team ? admin ? <AuditLogSettings key={workspaceId} workspaceId={workspaceId} /> : <p role="status" className="text-sm text-muted-foreground">{t('audit.adminOnly')}</p> : waiting
    case 'usage': return workspaceId && !preview ? <UsageSettings key={workspaceId} workspaceId={workspaceId} personal={personal} /> : waiting
    case 'billing': return workspaceId && !preview ? <>{team && <PaymentDesignationSettings key={`payment-${workspaceId}`} workspaceId={workspaceId} />}{admin && <BillingSettings key={workspaceId} workspaceId={workspaceId} personal={personal} />}</> : waiting
    // Bots of people who left are a team's (decision 2026-11-02-0203); they moved here with Bot 与 Agents' removal (2026-11-02-1400).
    case 'general': return <WorkspaceGeneral userKey={userKey ?? user.email} workspaceId={workspaceId} showArchived={Boolean(team && workspaceId && !preview)} />
    case 'computers': return null
    case 'permissions': return workspaceId && !preview ? <TeamPermissionsSettings key={workspaceId} workspaceId={workspaceId} /> : waiting
    default: return null
  }
}
