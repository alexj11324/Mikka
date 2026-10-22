'use client'

import { useRouter } from '@/i18n/navigation'
import { useTranslations } from 'next-intl'
import { AppShell } from '@/components/app-shell'
import { SettingsView } from '@/components/settings/settings-view'
import { authClient } from '@/lib/auth-client'
import { useState } from 'react'

export function MembersPageView({ user, workspaceId, inviteInitially }: { user: { name: string; email: string }; workspaceId?: string; inviteInitially: boolean }) {
  const router = useRouter()
  const t = useTranslations('Workspace')
  const [signingOut, setSigningOut] = useState(false)
  const [error, setError] = useState('')
  async function signOut() {
    if (signingOut) return
    setSigningOut(true)
    setError('')
    try {
      const result = await authClient.signOut()
      if (result.error) throw new Error('sign-out')
      router.replace('/sign-in')
      router.refresh()
    } catch {
      setError(t('signOutFailed'))
      setSigningOut(false)
    }
  }
  return <AppShell><SettingsView user={user} activeSection="members" workspaceId={workspaceId} inviteInitially={inviteInitially} onBack={() => router.push('/')} onSignOut={signOut} signingOut={signingOut} accountError={error} /></AppShell>
}
