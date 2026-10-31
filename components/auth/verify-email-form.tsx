'use client'

import { useLayoutEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { readLinkError, sendVerificationEmail } from '@/lib/auth-recovery'
import { EmailRequestForm } from './email-request-form'

// The link in the email is consumed by the backend, which then redirects to
// sign-in without signing the person in. This page requests a new link, and
// is where a failed link lands (?error=…).
export function VerifyEmailForm() {
  const t = useTranslations('Auth')
  const [linkFailed, setLinkFailed] = useState(false)
  useLayoutEffect(() => {
    const { failed, cleaned } = readLinkError(window.location.href)
    if (!failed) return
    window.history.replaceState(window.history.state, '', cleaned)
    setLinkFailed(true)
  }, [])
  return <EmailRequestForm title={t('verifyTitle')} description={linkFailed ? t('verifyLinkInvalid') : t('verifyDescription')} submitLabel={t('sendVerification')} send={sendVerificationEmail} turnstile />
}
