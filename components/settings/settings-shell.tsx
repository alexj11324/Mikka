'use client'

import { useState, type ReactNode } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useSWRConfig } from 'swr'
import { authClient } from '@/lib/auth-client'
import { AppShell } from '@/components/app-shell'
import { SettingsView, type SettingsSection } from './settings-view'

export function SettingsShell({ user, children }: { user: { id: string; name: string; email: string; image?: string | null }; children: ReactNode }) {
  const pathname = usePathname()
  const params = useSearchParams()
  const router = useRouter()
  const { mutate } = useSWRConfig()
  const [signingOut, setSigningOut] = useState(false)
  const [error, setError] = useState('')
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
    } catch { setError('退出失败，请稍后重试。'); setSigningOut(false) }
  }
  return <AppShell variant="settings"><SettingsView user={user} activeSection={section} workspaceId={params.get('workspace') ?? undefined} selectedTeamId={params.get('team') ?? undefined} onBack={() => router.push(params.get('team') ? `/?team=${encodeURIComponent(params.get('team')!)}` : '/')} onSignOut={() => void signOut()} signingOut={signingOut} accountError={error}>{children}</SettingsView></AppShell>
}
