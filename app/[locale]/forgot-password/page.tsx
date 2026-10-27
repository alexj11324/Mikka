import type { Metadata } from 'next'
import { getLocale, getTranslations } from 'next-intl/server'

import { ForgotPasswordForm } from '@/components/auth/forgot-password-form'

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale()
  const t = await getTranslations({ locale, namespace: 'Metadata' })
  return { title: t('forgotPasswordTitle'), description: t('forgotPasswordDescription') }
}

export default function ForgotPasswordPage() {
  return <ForgotPasswordForm />
}
