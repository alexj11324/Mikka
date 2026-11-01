'use client'

import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import { buttonVariants } from '@/components/ui/button'
import { AuthLogo } from './auth-logo'

// Each auth card carries its own way back (the sign-in / sign-up switch, or
// 「返回登录」) at the bottom, so the header holds only the logo (R-32).
export function Auth({ addAccount = false, registering = false, children, next = '/', label }: { registering?: boolean; addAccount?: boolean; children: ReactNode; next?: string; label?: string }) {
  const t = useTranslations('Auth')
  return (
    <main className="bg-background text-foreground flex min-h-svh w-full flex-col">
      <header className="flex items-center justify-between gap-4 px-5 py-5 sm:px-8 sm:py-6 lg:px-10">
        <AuthLogo />
        <div className="flex items-center gap-2 text-base">
          {addAccount && <Link href={next} className={buttonVariants({ variant: 'link', className: 'text-base' })}>{t('returnToCurrentAccount')}</Link>}
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
