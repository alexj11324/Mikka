'use client'
import { useTranslations } from 'next-intl'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { usePathname, useRouter } from '@/i18n/navigation'
import { useSWRConfig } from 'swr'
import { authClient } from '@/lib/auth-client'
import { AppShell } from '@/components/app-shell'
import { SettingsView, type SettingsSection } from './settings-view'
import { TeamDirectory } from '@/components/teams/team-directory'
import { MembersSettings } from '@/components/workspace/members-settings'
import { pushSettingsHistory } from '@/lib/settings-navigation'

export function SettingsShell({ user, defaultWorkspaceId }: { user: { id: string; name: string; email: string; image?: string | null }; defaultWorkspaceId?: string }) {
  const i18nText = useTranslations();
  const pathname = usePathname()
  const params = useSearchParams()
  const router = useRouter()
  const { mutate } = useSWRConfig()
  const [signingOut, setSigningOut] = useState(false)
  const [error, setError] = useState('')
  const workspaceId = params.get('workspace') ?? defaultWorkspaceId
  const requested = params.get('section')
  const section: SettingsSection = pathname === '/settings/teams' ? 'teams' : pathname === '/settings/members' ? 'members' : requested === 'profile' || requested === 'workspace' ? requested : 'preferences'
  async function signOut() {
    if (signingOut) return
    setSigningOut(true); setError('')
    try {
      const result = await authClient.signOut()
      if (result.error) throw new Error('sign out failed')
      await mutate(() => true, undefined, { revalidate: false })
      router.replace('/sign-in?login=1'); router.refresh()
    } catch { setError(i18nText("Workspace.signOutFailed")); setSigningOut(false) }
  }
  return <AppShell variant="settings"><SettingsView user={user} activeSection={section} workspaceId={workspaceId} selectedTeamId={params.get('team') ?? undefined} onBack={() => { const href = params.get('team') ? `/?team=${encodeURIComponent(params.get('team')!)}` : '/'; if (!pushSettingsHistory(href)) router.push(href) }} onSignOut={() => void signOut()} signingOut={signingOut} accountError={error}>{section === 'teams' && <TeamDirectory key={workspaceId ?? 'default'} workspaceId={workspaceId} />}{section === 'members' && <MembersSettings key={`${workspaceId ?? 'default'}-${params.get('invite') ?? ''}`} workspaceId={workspaceId} inviteInitially={params.get('invite') === '1'} embedded />}</SettingsView></AppShell>
}
