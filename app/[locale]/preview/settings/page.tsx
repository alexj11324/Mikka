import type { Metadata } from 'next'
import { getLocale, getTranslations } from 'next-intl/server'
import { SettingsPreview } from '@/components/settings/settings-preview'
import { redirect } from '@/i18n/navigation'

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale()
  const t = await getTranslations({ locale, namespace: 'Metadata' })
  return {
    title: t('settingsPreviewTitle'),
    description: t('settingsPreviewDescription'),
    robots: { index: false, follow: false },
  }
}

export default async function PreviewSettingsPage({ searchParams }: { searchParams: Promise<{ workspace?: string; invite?: string }> }) {
  const query = await searchParams
  if (process.env.NODE_ENV === 'development' && query.workspace === undefined && query.invite === undefined) return <SettingsPreview />
  const params = new URLSearchParams()
  if (typeof query.workspace === 'string') params.set('workspace', query.workspace)
  if (query.invite === '1') params.set('invite', '1')
  const suffix = params.toString()
  redirect({ href: `/settings/members${suffix ? `?${suffix}` : ''}`, locale: await getLocale() })
}
