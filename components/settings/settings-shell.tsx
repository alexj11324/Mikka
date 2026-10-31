'use client'
import { useTranslations } from 'next-intl'

import { useState, type ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import { usePathname, useRouter } from '@/i18n/navigation'
import { useSWRConfig } from 'swr'
import { endSession } from '@/lib/auth-client'
import { AppFrame, SignOutBoundary, WindowBar } from '@/components/app-shell'
import { IconRail, type RailDestination } from '@/components/nav/icon-rail'
import { SettingsView } from './settings-view'
import { resolveSettingsSection } from '@/lib/settings-sections'
import { TeamDirectory } from '@/components/teams/team-directory'
import { MembersSettings } from '@/components/workspace/members-settings'
import { pushSettingsHistory } from '@/lib/settings-navigation'

type RailMenu = { user: { name: string; email: string; image?: string | null }; onSettings: (href?: string) => void; onSignOut: () => void; signingOut: boolean }

/** Where a rail item lands when it is chosen from Settings. */
export function railHref(destination: RailDestination) {
  return destination === 'chats' ? '/' : `/?section=${destination === 'board' ? 'all-issues' : destination}`
}

/**
 * Settings inside the app window, like Codex: the window bar and icon rail
 * stay, the section list takes the second column and the section scrolls in
 * the card. Nothing on the rail is current, so any item leaves Settings.
 */
export function SettingsFrame({ onRail, children, ...menu }: RailMenu & { onRail: (destination: RailDestination) => void; children: ReactNode }) {
  return <AppFrame settings bar={<WindowBar center={null} />} rail={<IconRail active={null} onNavigate={onRail} {...menu} />}>{children}</AppFrame>
}

export function SettingsShell({ user, defaultWorkspaceId, googleEnabled = false, onRail: onRailOverride }: { user: { id: string; name: string; email: string; image?: string | null }; defaultWorkspaceId?: string; googleEnabled?: boolean; onRail?: (destination: RailDestination) => void }) {
  const i18nText = useTranslations();
  const pathname = usePathname()
  const params = useSearchParams()
  const router = useRouter()
  const { mutate } = useSWRConfig()
  const [signingOut, setSigningOut] = useState(false)
  const [error, setError] = useState('')
  const workspaceId = params.get('workspace') ?? defaultWorkspaceId
  const section = resolveSettingsSection(pathname, params.get('section'))
  async function signOut() {
    if (signingOut) return
    setSigningOut(true); setError('')
    try {
      const result = await endSession()
      if (result.error) throw new Error('sign out failed')
      await mutate(() => true, undefined, { revalidate: false })
      router.replace('/sign-in?login=1'); router.refresh()
    } catch { setError(i18nText("Workspace.signOutFailed")); setSigningOut(false) }
  }
  const go = (href: string) => { if (!pushSettingsHistory(href, workspaceId)) router.push(href) }
  const onRail = (destination: RailDestination) => { if (onRailOverride) onRailOverride(destination); else go(railHref(destination)) }
  return <SignOutBoundary pending={signingOut}><SettingsFrame user={user} onRail={onRail} onSettings={href => go(href ?? '/settings')} onSignOut={() => void signOut()} signingOut={signingOut}>
    <SettingsView user={user} userKey={user.id} googleEnabled={googleEnabled} activeSection={section} workspaceId={workspaceId} selectedTeamId={params.get('team') ?? undefined} onRail={onRail} onSignOut={() => void signOut()} signingOut={signingOut} accountError={error}>{section === 'teams' && <TeamDirectory key={workspaceId ?? 'default'} workspaceId={workspaceId} />}{section === 'members' && <MembersSettings key={`${workspaceId ?? 'default'}-${params.get('invite') ?? ''}`} workspaceId={workspaceId} inviteInitially={params.get('invite') === '1'} embedded />}</SettingsView>
  </SettingsFrame></SignOutBoundary>
}
