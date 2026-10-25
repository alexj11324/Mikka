import type { Metadata } from 'next'
import { getLocale, getTranslations } from 'next-intl/server'

import { ResetPasswordForm } from '@/components/auth/reset-password-form'
import { resetPageState } from '@/lib/auth-recovery'

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale()
  const t = await getTranslations({ locale, namespace: 'Metadata' })
  return { title: t('resetPasswordTitle'), description: t('resetPasswordDescription') }
}

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <ResetPasswordForm state={resetPageState(await searchParams)} />
}
