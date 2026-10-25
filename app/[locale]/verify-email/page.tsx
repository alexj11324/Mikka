import type { Metadata } from 'next'
import { getLocale, getTranslations } from 'next-intl/server'

import { VerifyEmailForm } from '@/components/auth/verify-email-form'

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale()
  const t = await getTranslations({ locale, namespace: 'Metadata' })
  return { title: t('verifyEmailTitle'), description: t('verifyEmailDescription') }
}

export default function VerifyEmailPage() {
  return <VerifyEmailForm />
}
