'use client'

import { useTranslations } from '@/lib/intl/i18n-client'
import { requestPasswordReset } from '@/lib/auth-recovery'
import { EmailRequestForm } from './email-request-form'

export function ForgotPasswordForm() {
  const t = useTranslations('Auth')
  return <EmailRequestForm title={t('forgotTitle')} submitLabel={t('sendResetLink')} send={requestPasswordReset} />
}
