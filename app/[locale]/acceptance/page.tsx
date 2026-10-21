import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'
import { auth } from '@/lib/auth'
import { isAcceptanceEnabled } from '@/lib/acceptance'
import { AcceptanceEntry } from '@/components/acceptance-entry'
import { redirect } from '@/i18n/navigation'

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale()
  const t = await getTranslations({ locale, namespace: 'Metadata' })
  return {
    title: t('acceptanceTitle'),
    description: t('acceptanceDescription'),
    robots: { index: false, follow: false },
  }
}

export default async function AcceptancePage() {
  if (!isAcceptanceEnabled()) notFound()
  const session = await auth.api.getSession({ headers: await headers() })
  if (session?.user) redirect({ href: '/', locale: await getLocale() })
  return <AcceptanceEntry />
}
