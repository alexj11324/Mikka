'use client'

import { useRef, useState, type FormEvent } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowRightIcon, LockKeyholeIcon } from 'lucide-react'
import { Auth } from '@/components/blocks/auth-19/components/auth'
import { AuthCard } from '@/components/blocks/auth-19/components/auth-card'
import { Button, buttonVariants } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Spinner } from '@/components/ui/spinner'
import { Link } from '@/i18n/navigation'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, newPasswordProblem, recoveryMessageKey, resetPassword, type ResetPageState } from '@/lib/auth-recovery'

export function ResetPasswordForm({ state }: { state: ResetPageState }) {
  const t = useTranslations('Auth')
  const pendingRef = useRef(false)
  const [pending, setPending] = useState(false)
  const [linkInvalid, setLinkInvalid] = useState(state.kind === 'invalid')
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (state.kind !== 'form' || pendingRef.current) return
    const data = new FormData(event.currentTarget)
    const password = String(data.get('password'))
    const problem = newPasswordProblem(password, String(data.get('confirmation')))
    if (problem) {
      setError(problem === 'length' ? t('passwordLength') : t('passwordMismatch'))
      return
    }
    pendingRef.current = true
    setPending(true)
    setError('')
    try {
      const result = await resetPassword({ token: state.token, newPassword: password })
      if (result.ok) setDone(true)
      else if (result.error === 'invalid_token') setLinkInvalid(true)
      else setError(t(recoveryMessageKey(result.error)))
    } catch {
      setError(t('connectionFailed'))
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }
  if (linkInvalid) return <Auth label={t('resetTitle')}>
    <AuthCard title={t('resetTitle')} description={t('resetLinkInvalid')}>
      <Link href="/forgot-password" className={buttonVariants({ className: 'w-full' })}>{t('requestNewLink')}</Link>
    </AuthCard>
  </Auth>
  if (done) return <Auth label={t('resetTitle')}>
    <AuthCard title={t('resetTitle')} description={t('resetDone')}>
      <Link href="/sign-in?login=1" className={buttonVariants({ className: 'w-full' })}>{t('signIn')}</Link>
    </AuthCard>
  </Auth>
  return <Auth label={t('resetTitle')}>
    <AuthCard title={t('resetTitle')} description={t('resetDescription')}>
      {error && <p id="recovery-error" role="alert" className="text-destructive text-sm">{error}</p>}
      <form className="flex flex-col gap-5" onSubmit={submit} aria-busy={pending} aria-describedby={error ? 'recovery-error' : undefined}>
        <FieldGroup>
          <Field data-disabled={pending} className="gap-2">
            <FieldLabel htmlFor="password">{t('newPassword')}</FieldLabel>
            <InputGroup>
              <InputGroupAddon><LockKeyholeIcon aria-hidden="true" /></InputGroupAddon>
              <InputGroupInput id="password" name="password" type="password" autoComplete="new-password" placeholder={t('passwordPlaceholder')} minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} required disabled={pending} />
            </InputGroup>
          </Field>
          <Field data-disabled={pending} className="gap-2">
            <FieldLabel htmlFor="confirmation">{t('confirmPassword')}</FieldLabel>
            <InputGroup>
              <InputGroupAddon><LockKeyholeIcon aria-hidden="true" /></InputGroupAddon>
              <InputGroupInput id="confirmation" name="confirmation" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} required disabled={pending} />
            </InputGroup>
          </Field>
        </FieldGroup>
        <Button type="submit" className="w-full" disabled={pending}>
          {t('submitReset')}
          {pending ? <Spinner data-icon="inline-end" /> : <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />}
        </Button>
      </form>
    </AuthCard>
  </Auth>
}
