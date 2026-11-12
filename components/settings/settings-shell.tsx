'use client'
import { useTranslations } from 'next-intl'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { usePathname, useRouter } from '@/i18n/navigation'
import { useSWRConfig } from 'swr'
import { endSession } from '@/lib/auth-client'
import { SignOutBoundary } from '@/components/app-shell'
import { SettingsFrame } from '@ui-slot/settings-frame'
import type { RailDestination } from '@/components/nav/icon-rail'
import { SettingsView } from './settings-view'
import { resolveSettingsSection } from '@/lib/settings-sections'
import { pushSettingsHistory, requestShellBrowser, requestShellSearch } from '@/lib/settings-navigation'
import { workspaceLink } from '@/components/workspace/workspace-navigation'

/** The app frame around settings. Its look is a UI slot (docs/ui-overlay.md). */
export { SettingsFrame }

/** Where a rail item lands when it is chosen from Settings. */
export function railHref(destination: RailDestination) {
  return workspaceLink({ section: destination === 'chats' ? 'coordinator' : destination === 'board' ? 'all-issues' : destination })
}

/**
 * Settings inside the app window, like Codex: the window bar and icon rail
 * stay, the section list takes the second column and the section scrolls in
 * the card. Nothing on the rail is current, so any item leaves Settings.
 * The window bar is the app's own (R-35): the ⌘K pill and the 浏览器 globe
 * stay, and each leaves Settings for the app with search or the browser open.
 */

/** Routed settings content also lives inside the workspace's persistent frame. */
export function SettingsRouteContent({ user, defaultWorkspaceId, googleEnabled = false, onRail, onSignOut, signingOut, accountError }: { user: { id: string; name: string; email: string; image?: string | null }; defaultWorkspaceId?: string; googleEnabled?: boolean } & Pick<Parameters<typeof SettingsView>[0], 'onRail' | 'onSignOut' | 'signingOut' | 'accountError'>) {
  const pathname = usePathname()
  const params = useSearchParams()
  const workspaceId = params.get('workspace') ?? defaultWorkspaceId
  const section = resolveSettingsSection(pathname, params.get('section'))
  return <SettingsView user={user} userKey={user.id} googleEnabled={googleEnabled} activeSection={section} workspaceId={workspaceId} inviteInitially={params.get('invite') === '1'} selectedTeamId={params.get('team') ?? undefined} onRail={onRail} onSignOut={onSignOut} signingOut={signingOut} accountError={accountError} />
}

export function SettingsShell({ user, defaultWorkspaceId, googleEnabled = false, onRail: onRailOverride, onSearch: onSearchOverride, onBrowser: onBrowserOverride }: { user: { id: string; name: string; email: string; image?: string | null }; defaultWorkspaceId?: string; googleEnabled?: boolean; onRail?: (destination: RailDestination) => void; onSearch?: () => void; onBrowser?: () => void }) {
  const i18nText = useTranslations();
  const params = useSearchParams()
  const router = useRouter()
  const { mutate } = useSWRConfig()
  const [signingOut, setSigningOut] = useState(false)
  const [error, setError] = useState('')
  const workspaceId = params.get('workspace') ?? defaultWorkspaceId
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
  // Opened straight on /settings there is no app behind it yet: ask the app that mounts at / to open search or the browser.
  const onSearch = onSearchOverride ?? (() => { requestShellSearch(); go('/') })
  const onBrowser = onBrowserOverride ?? (() => { requestShellBrowser(); go('/') })
  return <SignOutBoundary pending={signingOut}><SettingsFrame user={user} onRail={onRail} onSearch={onSearch} onBrowser={onBrowser} onSettings={href => go(href ?? '/settings')} onSignOut={() => void signOut()} signingOut={signingOut}>
    <SettingsRouteContent user={user} defaultWorkspaceId={defaultWorkspaceId} googleEnabled={googleEnabled} onRail={onRail} onSignOut={() => void signOut()} signingOut={signingOut} accountError={error} />
  </SettingsFrame></SignOutBoundary>
}
