'use client'

import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { SettingsView } from '@/components/settings/settings-view'
import { AppShell } from '@/components/app-shell'

export function SettingsPreview() {
  const t = useTranslations('Settings')
  const router = useRouter()
  return (
    <AppShell variant="settings">
        <SettingsView
          user={{ name: t('preview.userName'), email: 'preview@example.com' }}
          onBack={() => router.push('/sign-in')}
          onSignOut={() => router.push('/sign-in')}
          signingOut={false}
          accountError=""
        />
    </AppShell>
  )
}
