'use client'

import type { FormEventHandler } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { ArrowRightIcon, Loader2Icon, LockKeyholeIcon, MailIcon, UserIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Separator } from '@/components/ui/separator'
import { GithubDark } from '@/components/ui/svgs/githubDark'
import { GithubLight } from '@/components/ui/svgs/githubLight'

type SignInCardProps = {
  registering: boolean
  addAccount?: boolean
  pending: boolean
  githubEnabled: boolean
  error: string
  notice: string
  callbackURL?: string
  next?: string
  onSubmit: FormEventHandler<HTMLFormElement>
  onGitHubSignIn: () => Promise<void>
}

export function SignInCard({ registering, addAccount = false, pending, githubEnabled, error, notice, callbackURL, next = '/', onSubmit, onGitHubSignIn }: SignInCardProps) {
  const t = useTranslations('Auth')
  function authHref(path: string) {
    const params = new URLSearchParams()
    if (next !== '/') params.set('next', next)
    if (addAccount) params.set('addAccount', '1')
    const query = params.toString()
    return `${path}${query ? `?${query}` : ''}`
  }
  return (
    <Card className="w-full max-w-[26rem] overflow-hidden p-0">
      <CardHeader className="px-7 pt-8 pb-5 sm:px-9 sm:pt-9 sm:pb-6">
        <div className="flex flex-col gap-1">
          <CardTitle className="text-2xl font-semibold tracking-tight text-balance">
            <h1>{addAccount ? t('addAccountTitle') : registering ? t('createTitle') : t('welcome')}</h1>
          </CardTitle>
          <CardDescription className="text-pretty">
            {addAccount ? t('addAccountDescription') : registering ? t('createDescription') : t('welcomeDescription')}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-6 px-7 pb-7 sm:px-9 sm:pb-8">
        <div className="flex flex-col gap-3">
          <Button type="button" variant="outline" className="w-full justify-center px-4" disabled={pending || !githubEnabled} onClick={onGitHubSignIn}>
            {pending ? <Loader2Icon aria-hidden="true" className="animate-spin" data-icon="inline-start" /> : <>
              <span aria-hidden="true" className="dark:hidden"><GithubLight className="size-4" /></span>
              <span aria-hidden="true" className="hidden dark:block"><GithubDark className="size-4" /></span>
            </>}
            {t('continueGithub')}
          </Button>
          <p className="text-muted-foreground text-xs leading-5">{githubEnabled ? t('githubScope') : t('githubNotConfigured')}</p>
          {!githubEnabled && callbackURL && <details className="text-muted-foreground text-xs"><summary className="cursor-pointer">{t('viewCallback')}</summary><code className="mt-2 block break-all select-all">{callbackURL}</code></details>}
          {notice && <p role="status" className="text-xs leading-5">{notice}</p>}
        </div>
        <div className="flex items-center gap-3">
          <Separator className="flex-1" />
          <span className="text-muted-foreground text-xs">{t('orEmail')}</span>
          <Separator className="flex-1" />
        </div>
        {error && <p id="auth-error" role="alert" className="text-destructive text-sm">{error}</p>}
        <form method="post" className="flex flex-col gap-5" onSubmit={onSubmit} aria-busy={pending} aria-describedby={error ? 'auth-error' : undefined}>
          <FieldGroup>
            {registering && <Field data-disabled={pending} className="gap-2">
              <FieldLabel htmlFor="name">{t('name')}</FieldLabel>
              <InputGroup>
                <InputGroupAddon><UserIcon aria-hidden="true" /></InputGroupAddon>
                <InputGroupInput id="name" name="name" autoComplete="name" placeholder={t('namePlaceholder')} minLength={1} maxLength={80} required disabled={pending} />
              </InputGroup>
            </Field>}
            <Field data-disabled={pending} className="gap-2">
              <FieldLabel htmlFor="email">{t('email')}</FieldLabel>
              <InputGroup>
                <InputGroupAddon><MailIcon aria-hidden="true" /></InputGroupAddon>
                <InputGroupInput id="email" name="email" type="email" autoComplete="email" placeholder="you@example.com" required disabled={pending} />
              </InputGroup>
            </Field>
            <Field data-disabled={pending} className="gap-2">
              <FieldLabel htmlFor="password">{t('password')}</FieldLabel>
              <InputGroup>
                <InputGroupAddon><LockKeyholeIcon aria-hidden="true" /></InputGroupAddon>
                <InputGroupInput id="password" name="password" type="password" autoComplete={registering ? 'new-password' : 'current-password'} placeholder={t('passwordPlaceholder')} minLength={8} maxLength={128} required disabled={pending} />
              </InputGroup>
            </Field>
          </FieldGroup>
          <Button type="submit" className="w-full" disabled={pending}>
            {registering ? t('submitCreate') : t('submitSignIn')}
            {pending ? <Loader2Icon aria-hidden="true" className="animate-spin" data-icon="inline-end" /> : <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />}
          </Button>
        </form>
        <p className="text-muted-foreground text-center text-xs">
          {registering ? t('haveAccount') : t('noAccountShort')}{' '}
          <Link href={authHref(registering ? '/sign-in' : '/sign-up')} className="text-foreground underline underline-offset-4">{registering ? t('signIn') : t('createAccount')}</Link>
        </p>
      </CardContent>
    </Card>
  )
}
