import type { Metadata } from 'next'
import { getLocale, getTranslations } from 'next-intl/server'

import { VerifyEmailNotice } from '@/components/auth/verify-email-notice'
import { verifyPageState } from '@/lib/auth-recovery'

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale()
  const t = await getTranslations({ locale, namespace: 'Metadata' })
  return { title: t('verifyEmailTitle'), description: t('verifyEmailDescription') }
}

export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <VerifyEmailNotice state={verifyPageState(await searchParams)} />
}
