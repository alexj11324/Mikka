'use client'

import { useRef, useState, type FormEvent } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { MailIcon } from 'lucide-react'
import { Auth } from '@/components/blocks/auth-19/components/auth'
import { AuthCard } from '@/components/blocks/auth-19/components/auth-card'
import { Button, buttonVariants } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Spinner } from '@/components/ui/spinner'
import { Link, getPathname } from '@/i18n/navigation'
import { recoveryMessageKey, sendVerificationEmail, type VerifyPageState } from '@/lib/auth-recovery'
import { withBasePath } from '@/lib/base-path'

export function VerifyEmailNotice({ state }: { state: VerifyPageState }) {
  const t = useTranslations('Auth')
  const locale = useLocale()
  const pendingRef = useRef(false)
  const [pending, setPending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  async function resend(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pendingRef.current) return
    const email = String(new FormData(event.currentTarget).get('email')).trim()
    pendingRef.current = true
    setPending(true)
    setError('')
    try {
      const callbackURL = new URL(withBasePath(getPathname({ locale, href: '/verify-email' })), window.location.origin).href
      const result = await sendVerificationEmail({ email, callbackURL })
      if (result.ok) setSent(true)
      else setError(t(recoveryMessageKey(result.error)))
    } catch {
      setError(t('connectionFailed'))
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }
  if (state === 'verified') return <Auth label={t('verifyTitle')}>
    <AuthCard title={t('verifyDoneTitle')} description={t('verifyDoneDescription')}>
      <Link href="/sign-in?login=1" className={buttonVariants({ className: 'w-full' })}>{t('signIn')}</Link>
    </AuthCard>
  </Auth>
  return <Auth label={t('verifyTitle')}>
    <AuthCard title={t('verifyTitle')} description={sent ? t('verificationSent') : state === 'invalid' ? t('verifyInvalid') : t('verifyPending')}>
      {error && <p id="recovery-error" role="alert" className="text-destructive text-sm">{error}</p>}
      <form className="flex flex-col gap-5" onSubmit={resend} aria-busy={pending} aria-describedby={error ? 'recovery-error' : undefined}>
        <FieldGroup>
          <Field data-disabled={pending} className="gap-2">
            <FieldLabel htmlFor="email">{t('email')}</FieldLabel>
            <InputGroup>
              <InputGroupAddon><MailIcon aria-hidden="true" /></InputGroupAddon>
              <InputGroupInput id="email" name="email" type="email" autoComplete="email" placeholder="you@example.com" required disabled={pending} />
            </InputGroup>
          </Field>
        </FieldGroup>
        <Button type="submit" variant="outline" className="w-full" disabled={pending}>
          {pending && <Spinner />}
          {t('sendVerification')}
        </Button>
      </form>
      <p className="text-muted-foreground text-center text-xs">
        <Link href="/sign-in" className="text-foreground underline underline-offset-4">{t('backToSignIn')}</Link>
      </p>
    </AuthCard>
  </Auth>
}
