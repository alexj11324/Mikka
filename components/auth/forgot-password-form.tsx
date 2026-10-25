'use client'

import { useRef, useState, type FormEvent } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { ArrowRightIcon, MailIcon } from 'lucide-react'
import { Auth } from '@/components/blocks/auth-19/components/auth'
import { AuthCard } from '@/components/blocks/auth-19/components/auth-card'
import { Button } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Spinner } from '@/components/ui/spinner'
import { Link, getPathname } from '@/i18n/navigation'
import { recoveryMessageKey, requestPasswordReset } from '@/lib/auth-recovery'
import { withBasePath } from '@/lib/base-path'

export function ForgotPasswordForm() {
  const t = useTranslations('Auth')
  const locale = useLocale()
  const pendingRef = useRef(false)
  const [pending, setPending] = useState(false)
  const [sentTo, setSentTo] = useState('')
  const [error, setError] = useState('')
  async function send(email: string) {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    setError('')
    try {
      const redirectTo = new URL(withBasePath(getPathname({ locale, href: '/reset-password' })), window.location.origin).href
      const result = await requestPasswordReset({ email, redirectTo })
      if (result.ok) setSentTo(email)
      else setError(t(recoveryMessageKey(result.error)))
    } catch {
      setError(t('connectionFailed'))
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void send(String(new FormData(event.currentTarget).get('email')).trim())
  }
  return <Auth label={t('forgotTitle')}>
    <AuthCard title={t('forgotTitle')} description={sentTo ? t('resetLinkSent') : t('forgotDescription')}>
      {error && <p id="recovery-error" role="alert" className="text-destructive text-sm">{error}</p>}
      {sentTo
        ? <Button type="button" variant="outline" className="w-full" disabled={pending} onClick={() => void send(sentTo)}>
          {pending && <Spinner />}
          {t('resendLink')}
        </Button>
        : <form className="flex flex-col gap-5" onSubmit={submit} aria-busy={pending} aria-describedby={error ? 'recovery-error' : undefined}>
          <FieldGroup>
            <Field data-disabled={pending} className="gap-2">
              <FieldLabel htmlFor="email">{t('email')}</FieldLabel>
              <InputGroup>
                <InputGroupAddon><MailIcon aria-hidden="true" /></InputGroupAddon>
                <InputGroupInput id="email" name="email" type="email" autoComplete="email" placeholder="you@example.com" required disabled={pending} />
              </InputGroup>
            </Field>
          </FieldGroup>
          <Button type="submit" className="w-full" disabled={pending}>
            {t('sendResetLink')}
            {pending ? <Spinner data-icon="inline-end" /> : <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />}
          </Button>
        </form>}
      <p className="text-muted-foreground text-center text-xs">
        <Link href="/sign-in" className="text-foreground underline underline-offset-4">{t('backToSignIn')}</Link>
      </p>
    </AuthCard>
  </Auth>
}
