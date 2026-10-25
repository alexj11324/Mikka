'use client'

import { useTranslations } from 'next-intl'
import { requestPasswordReset } from '@/lib/auth-recovery'
import { EmailRequestForm } from './email-request-form'

export function ForgotPasswordForm() {
  const t = useTranslations('Auth')
  return <EmailRequestForm title={t('forgotTitle')} description={t('forgotDescription')} submitLabel={t('sendResetLink')} send={requestPasswordReset} />
}
