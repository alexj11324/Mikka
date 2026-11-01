'use client'

import { useTranslations } from 'next-intl'
import { useRouter } from '@/i18n/navigation'
import { SettingsView } from '@/components/settings/settings-view'
import { SettingsFrame } from '@/components/settings/settings-shell'

export function SettingsPreview() {
  const t = useTranslations('Settings')
  const router = useRouter()
  return (
    <SettingsFrame user={{ name: t('preview.userName'), email: 'preview@example.com' }} onRail={() => router.push('/sign-in')} onSearch={() => router.push('/sign-in')} onBrowser={() => router.push('/sign-in')} onSettings={() => {}} onSignOut={() => router.push('/sign-in')} signingOut={false}>
        <SettingsView
          user={{ name: t('preview.userName'), email: 'preview@example.com' }}
          googleEnabled={false}
          onRail={() => router.push('/sign-in')}
          onSignOut={() => router.push('/sign-in')}
          signingOut={false}
          accountError=""
          preview
        />
    </SettingsFrame>
  )
}
