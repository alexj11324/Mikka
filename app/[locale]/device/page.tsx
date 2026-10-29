import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { getLocale, getTranslations } from 'next-intl/server'
import { DeviceAuthorization } from '@/components/device-authorization'
import { redirect } from '@/i18n/navigation'
import { auth } from '@/lib/auth'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('DeviceAuthorization')
  return { title: t('title'), robots: { index: false, follow: false } }
}

export default async function DeviceAuthorizationPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams
  const initialCode = typeof query.user_code === 'string' && /^[A-Z0-9-]{4,32}$/.test(query.user_code) ? query.user_code : ''
  const returnPath = '/device' + (initialCode ? '?user_code=' + encodeURIComponent(initialCode) : '')
  const session = await auth.api.getSession({ headers: await headers() })
  const locale = await getLocale()
  if (!session?.user) redirect({ href: '/sign-in?next=' + encodeURIComponent(returnPath), locale })
  return <DeviceAuthorization account={session!.user.email} initialCode={initialCode} />
}
