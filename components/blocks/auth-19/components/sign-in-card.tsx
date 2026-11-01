'use client'

import { useState, type FormEvent, type FormEventHandler, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { ArrowRightIcon, Loader2Icon, LockKeyholeIcon, MailIcon, UserIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Separator } from '@/components/ui/separator'
import { GithubDark } from '@/components/ui/svgs/githubDark'
import { GithubLight } from '@/components/ui/svgs/githubLight'
import { Google } from '@/components/ui/svgs/google'

type SignInCardProps = {
  registering: boolean
  addAccount?: boolean
  pending: boolean
  googleEnabled: boolean
  githubEnabled: boolean
  /** Off while email sign-in is switched off in PostHog: GitHub and Google only. */
  emailEnabled?: boolean
  showGoogleLinkHint: boolean
  error: string
  notice: string
  next?: string
  onSubmit: FormEventHandler<HTMLFormElement>
  onGoogleSignIn: () => Promise<void>
  onGitHubSignIn: () => Promise<void>
  /** Sign-up's Turnstile widget; renders nothing without a site key. */
  turnstile?: ReactNode
}

type FieldName = 'name' | 'email' | 'password'
type FieldErrors = Partial<Record<FieldName, string>>
const FIELD_ORDER: FieldName[] = ['name', 'email', 'password']
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function SignInCard({ registering, addAccount = false, pending, googleEnabled, githubEnabled, emailEnabled = true, showGoogleLinkHint, error, notice, next = '/', onSubmit, onGoogleSignIn, onGitHubSignIn, turnstile }: SignInCardProps) {
  const t = useTranslations('Auth')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const oauthEnabled = googleEnabled || githubEnabled
  function authHref(path: string) {
    const params = new URLSearchParams()
    if (next !== '/') params.set('next', next)
    if (addAccount) params.set('addAccount', '1')
    const query = params.toString()
    return `${path}${query ? `?${query}` : ''}`
  }
  // The browser's validation bubble is not localised (R-42): the form opts
  // out with noValidate and each field reports its own error below it.
  function validate(form: HTMLFormElement): FieldErrors {
    const data = new FormData(form)
    const value = (field: FieldName) => String(data.get(field) ?? '')
    const errors: FieldErrors = {}
    if (registering && !value('name').trim()) errors.name = t('nameRequired')
    const email = value('email').trim()
    if (!email) errors.email = t('emailRequired')
    else if (!EMAIL_PATTERN.test(email)) errors.email = t('emailInvalid')
    const password = value('password')
    if (!password) errors.password = t('passwordRequired')
    else if (registering && password.length < 8) errors.password = t('passwordTooShort')
    return errors
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    const errors = validate(event.currentTarget)
    setFieldErrors(errors)
    const first = FIELD_ORDER.find(field => errors[field])
    if (first) {
      event.preventDefault()
      event.currentTarget.querySelector<HTMLInputElement>(`#${first}`)?.focus()
      return
    }
    onSubmit(event)
  }
  function clearFieldError(field: FieldName) {
    if (fieldErrors[field]) setFieldErrors(current => ({ ...current, [field]: undefined }))
  }
  function invalidProps(field: FieldName) {
    return {
      'aria-invalid': Boolean(fieldErrors[field]),
      'aria-describedby': fieldErrors[field] ? `${field}-error` : undefined,
      onInput: () => clearFieldError(field),
    }
  }
  return (
    <Card className="w-full max-w-[26rem] overflow-hidden p-0">
      <CardHeader className="px-7 pt-8 pb-5 sm:px-9 sm:pt-9 sm:pb-6">
        <CardTitle className="text-2xl font-semibold tracking-tight text-balance">
          <h1>{addAccount ? t('addAccountTitle') : registering ? t('createTitle') : t('welcome')}</h1>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6 px-7 pb-7 sm:px-9 sm:pb-8">
        {(oauthEnabled || notice) && <div className="flex flex-col gap-3">
          {googleEnabled && <Button type="button" variant="outline" className="w-full justify-center px-4" disabled={pending} onClick={onGoogleSignIn}>
            {pending ? <Loader2Icon aria-hidden="true" className="animate-spin" data-icon="inline-start" /> : <Google className="size-4" />}
            {t('continueGoogle')}
          </Button>}
          {showGoogleLinkHint && <p className="text-muted-foreground text-xs leading-5">{t('googleLinkHint')}</p>}
          {githubEnabled && <Button type="button" variant="outline" className="w-full justify-center px-4" disabled={pending} onClick={onGitHubSignIn}>
            {pending ? <Loader2Icon aria-hidden="true" className="animate-spin" data-icon="inline-start" /> : <>
              <span aria-hidden="true" className="dark:hidden"><GithubLight className="size-4" /></span>
              <span aria-hidden="true" className="hidden dark:block"><GithubDark className="size-4" /></span>
            </>}
            {t('continueGithub')}
          </Button>}
          {notice && <p role="status" className="text-xs leading-5">{notice}</p>}
        </div>}
        {emailEnabled ? <>
        {oauthEnabled && <div className="flex items-center gap-3">
          <Separator className="flex-1" />
          <span className="text-muted-foreground text-xs">{t('orEmail')}</span>
          <Separator className="flex-1" />
        </div>}
        {error && <p id="auth-error" role="alert" className="text-destructive text-sm">{error}</p>}
        {error && <p className="text-muted-foreground text-xs">
          <Link href="/verify-email" className="text-foreground underline underline-offset-4">{t('verifyEmailLink')}</Link>
        </p>}
        <form className="flex flex-col gap-5" noValidate onSubmit={submit} aria-busy={pending} aria-describedby={error ? 'auth-error' : undefined}>
          <FieldGroup>
            {registering && <Field data-disabled={pending} data-invalid={Boolean(fieldErrors.name)} className="gap-2">
              <FieldLabel htmlFor="name">{t('name')}</FieldLabel>
              <InputGroup>
                <InputGroupAddon><UserIcon aria-hidden="true" /></InputGroupAddon>
                <InputGroupInput id="name" name="name" autoComplete="name" placeholder={t('namePlaceholder')} minLength={1} maxLength={80} required disabled={pending} {...invalidProps('name')} />
              </InputGroup>
              {fieldErrors.name && <FieldError id="name-error">{fieldErrors.name}</FieldError>}
            </Field>}
            <Field data-disabled={pending} data-invalid={Boolean(fieldErrors.email)} className="gap-2">
              <FieldLabel htmlFor="email">{t('email')}</FieldLabel>
              <InputGroup>
                <InputGroupAddon><MailIcon aria-hidden="true" /></InputGroupAddon>
                <InputGroupInput id="email" name="email" type="email" autoComplete="email" placeholder="you@example.com" required disabled={pending} {...invalidProps('email')} />
              </InputGroup>
              {fieldErrors.email && <FieldError id="email-error">{fieldErrors.email}</FieldError>}
            </Field>
            <Field data-disabled={pending} data-invalid={Boolean(fieldErrors.password)} className="gap-2">
              <div className="flex items-center justify-between gap-3">
                <FieldLabel htmlFor="password">{t('password')}</FieldLabel>
                {!registering && <Link href="/forgot-password" className="text-muted-foreground text-xs underline-offset-4 hover:underline">{t('forgotPassword')}</Link>}
              </div>
              <InputGroup>
                <InputGroupAddon><LockKeyholeIcon aria-hidden="true" /></InputGroupAddon>
                <InputGroupInput id="password" name="password" type="password" autoComplete={registering ? 'new-password' : 'current-password'} placeholder={t('passwordPlaceholder')} minLength={8} maxLength={128} required disabled={pending} {...invalidProps('password')} />
              </InputGroup>
              {fieldErrors.password && <FieldError id="password-error">{fieldErrors.password}</FieldError>}
            </Field>
          </FieldGroup>
          {turnstile}
          <Button type="submit" className="w-full" disabled={pending}>
            {registering ? t('submitCreate') : t('submitSignIn')}
            {pending ? <Loader2Icon aria-hidden="true" className="animate-spin" data-icon="inline-end" /> : <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />}
          </Button>
        </form>
        </> : error && <p id="auth-error" role="alert" className="text-destructive text-sm">{error}</p>}
        {/* The one sign-in / sign-up switch; the page header no longer repeats it (R-32). */}
        <p className="text-muted-foreground text-center text-xs">
          {registering ? t('haveAccount') : t('noAccountShort')}{' '}
          <Link href={authHref(registering ? '/sign-in' : '/sign-up')} className="text-foreground underline underline-offset-4">{registering ? t('signIn') : t('createAccount')}</Link>
        </p>
      </CardContent>
    </Card>
  )
}
