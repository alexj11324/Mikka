import type { Metadata } from 'next'
import { getLocale, getTranslations } from 'next-intl/server'

import { ResetPasswordForm } from '@/components/auth/reset-password-form'

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale()
  const t = await getTranslations({ locale, namespace: 'Metadata' })
  return { title: t('resetPasswordTitle'), description: t('resetPasswordDescription') }
}

// The reset token never reaches server props: the form reads it from the
// address in the browser and removes it right away.
export default function ResetPasswordPage() {
  return <ResetPasswordForm />
}
