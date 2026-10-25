'use client'

import { useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslations } from 'next-intl'
import { ArrowRightIcon, LockKeyholeIcon } from 'lucide-react'
import { Auth } from '@/components/blocks/auth-19/components/auth'
import { AuthCard } from '@/components/blocks/auth-19/components/auth-card'
import { Button, buttonVariants } from '@/components/ui/button'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Spinner } from '@/components/ui/spinner'
import { Link } from '@/i18n/navigation'
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, newPasswordProblem, readResetLink, recoveryMessageKey, resetPassword } from '@/lib/auth-recovery'
import { useCooldown } from './use-cooldown'

type Stage = 'reading' | 'form' | 'invalid' | 'done'

export function ResetPasswordForm() {
  const t = useTranslations('Auth')
  // The token lives only in this ref: never in state, storage, the address
  // bar or logs.
  const tokenRef = useRef<string | null>(null)
  const pendingRef = useRef(false)
  const [stage, setStage] = useState<Stage>('reading')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [cooldown, startCooldown] = useCooldown()

  useLayoutEffect(() => {
    const { token, cleaned } = readResetLink(window.location.href)
    window.history.replaceState(window.history.state, '', cleaned)
    tokenRef.current = token
    setStage(token ? 'form' : 'invalid')
  }, [])

  function forget(form: HTMLFormElement, next: Stage) {
    tokenRef.current = null
    form.reset()
    setStage(next)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const token = tokenRef.current
    if (!token || pendingRef.current || cooldown > 0) return
    const data = new FormData(form)
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
      const result = await resetPassword(token, password)
      if (result.ok) forget(form, 'done')
      else if (result.error === 'invalid_token') forget(form, 'invalid')
      else if (result.error === 'rate_limited') startCooldown(result.retryAfter ?? 0)
      else setError(t(recoveryMessageKey(result.error)))
    } catch {
      setError(t('connectionFailed'))
    } finally {
      pendingRef.current = false
      setPending(false)
    }
  }

  if (stage === 'invalid') return <Auth label={t('resetTitle')}>
    <AuthCard title={t('resetTitle')} description={t('resetLinkInvalid')}>
      <Link href="/forgot-password" className={buttonVariants({ className: 'w-full' })}>{t('requestNewLink')}</Link>
    </AuthCard>
  </Auth>
  if (stage === 'done') return <Auth label={t('resetTitle')}>
    <AuthCard title={t('resetTitle')} description={t('resetDone')}>
      <Link href="/sign-in?login=1" className={buttonVariants({ className: 'w-full' })}>{t('signIn')}</Link>
    </AuthCard>
  </Auth>
  return <Auth label={t('resetTitle')}>
    <AuthCard title={t('resetTitle')} description={t('resetDescription')}>
      {error && <p id="recovery-error" role="alert" className="text-destructive text-sm">{error}</p>}
      <form className="flex flex-col gap-5" onSubmit={submit} aria-busy={pending} aria-describedby={error ? 'recovery-error' : undefined}>
        <FieldGroup>
          <Field data-disabled={pending || stage === 'reading'} className="gap-2">
            <FieldLabel htmlFor="password">{t('newPassword')}</FieldLabel>
            <InputGroup>
              <InputGroupAddon><LockKeyholeIcon aria-hidden="true" /></InputGroupAddon>
              <InputGroupInput id="password" name="password" type="password" autoComplete="new-password" placeholder={t('passwordPlaceholder')} minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} required disabled={pending || stage === 'reading'} />
            </InputGroup>
          </Field>
          <Field data-disabled={pending || stage === 'reading'} className="gap-2">
            <FieldLabel htmlFor="confirmation">{t('confirmPassword')}</FieldLabel>
            <InputGroup>
              <InputGroupAddon><LockKeyholeIcon aria-hidden="true" /></InputGroupAddon>
              <InputGroupInput id="confirmation" name="confirmation" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} required disabled={pending || stage === 'reading'} />
            </InputGroup>
          </Field>
        </FieldGroup>
        <Button type="submit" className="w-full" disabled={pending || stage === 'reading' || cooldown > 0}>
          {cooldown > 0 ? t('retryIn', { seconds: cooldown }) : t('submitReset')}
          {pending ? <Spinner data-icon="inline-end" /> : cooldown === 0 && <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />}
        </Button>
      </form>
    </AuthCard>
  </Auth>
}
