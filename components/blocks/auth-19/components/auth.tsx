'use client'

import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { buttonVariants } from '@/components/ui/button'
import { AuthLogo } from './auth-logo'

// switchInCard: the sign-in / sign-up card carries its own switch link at the
// bottom, so the header leaves it out instead of repeating it (R-32).
export function Auth({ registering = false, addAccount = false, switchInCard = false, children, next = '/', label }: { registering?: boolean; addAccount?: boolean; switchInCard?: boolean; children: ReactNode; next?: string; label?: string }) {
  const t = useTranslations('Auth')
  function authHref(path: string) {
    const params = new URLSearchParams()
    if (next !== '/') params.set('next', next)
    if (addAccount) params.set('addAccount', '1')
    const query = params.toString()
    return `${path}${query ? `?${query}` : ''}`
  }
  return (
    <main className="bg-background text-foreground flex min-h-svh w-full flex-col">
      <header className="flex items-center justify-between gap-4 px-5 py-5 sm:px-8 sm:py-6 lg:px-10">
        <AuthLogo />
        <div className="flex items-center gap-2 text-base">
          {addAccount ? <Link href={next} className={buttonVariants({ variant: 'link', className: 'text-base' })}>{t('returnToCurrentAccount')}</Link> : !switchInCard && <>
            <span className="text-muted-foreground hidden sm:inline">{registering ? t('haveAccount') : t('noAccount')}</span>
            <Link href={authHref(registering ? '/sign-in' : '/sign-up')} className={buttonVariants({ variant: 'link', className: 'text-base' })}>
              {registering ? t('signIn') : t('createAccount')}
            </Link>
          </>}
        </div>
      </header>
      <section aria-label={label ?? (addAccount ? t('addAccountLabel') : registering ? t('signUpLabel') : t('signInLabel'))} className="flex flex-1 items-center justify-center px-5 py-10 sm:px-8 sm:py-16">
        <div className="flex w-full flex-col items-center gap-6">
          {children}
        </div>
      </section>
    </main>
  )
}
