'use client'

import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { buttonVariants } from '@/components/ui/button'
import { AuthLogo } from './auth-logo'

export function Auth({ registering = false, children, next = '/' }: { registering?: boolean; children: ReactNode; next?: string }) {
  const t = useTranslations('Auth')
  return (
    <main className="bg-background text-foreground flex min-h-svh w-full flex-col">
      <header className="flex items-center justify-between gap-4 px-5 py-5 sm:px-8 sm:py-6 lg:px-10">
        <AuthLogo />
        <div className="flex items-center gap-2 text-base">
          <span className="text-muted-foreground hidden sm:inline">{registering ? t('haveAccount') : t('noAccount')}</span>
          <Link href={`${registering ? '/sign-in' : '/sign-up'}${next === '/' ? '' : `?next=${encodeURIComponent(next)}`}`} className={buttonVariants({ variant: 'link', className: 'text-base' })}>
            {registering ? t('signIn') : t('createAccount')}
          </Link>
        </div>
      </header>
      <section aria-label={registering ? t('signUpLabel') : t('signInLabel')} className="flex flex-1 items-center justify-center px-5 py-10 sm:px-8 sm:py-16">
        <div className="flex w-full flex-col items-center gap-6">
          {children}
          <footer className="text-muted-foreground flex max-w-[26rem] flex-col items-center gap-2 text-center text-sm leading-6 text-pretty">
            <p>{t('tagline')}</p>
            <p>{t('accountNote')}<br />{t('dataNote')}</p>
          </footer>
        </div>
      </section>
    </main>
  )
}
