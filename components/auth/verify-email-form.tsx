'use client'

import { useTranslations } from 'next-intl'
import { sendVerificationEmail } from '@/lib/auth-recovery'
import { EmailRequestForm } from './email-request-form'

// The link in the email is consumed by the backend, which then redirects to
// sign-in without signing the person in. This page only requests the link.
export function VerifyEmailForm() {
  const t = useTranslations('Auth')
  return <EmailRequestForm title={t('verifyTitle')} description={t('verifyDescription')} submitLabel={t('sendVerification')} send={sendVerificationEmail} />
}
