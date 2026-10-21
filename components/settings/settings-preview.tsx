'use client'

import { useRouter } from 'next/navigation'
import { SettingsView } from '@/components/settings/settings-view'
import { AppShell } from '@/components/app-shell'

export function SettingsPreview() {
  const router = useRouter()
  return (
    <AppShell>
        <SettingsView
          user={{ name: '预览用户', email: 'preview@example.com' }}
          onBack={() => router.push('/sign-in')}
          onSignOut={() => router.push('/sign-in')}
          signingOut={false}
          accountError=""
        />
    </AppShell>
  )
}
