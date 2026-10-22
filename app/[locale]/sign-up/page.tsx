import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect as plainRedirect } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'

import { AuthForm } from '@/components/auth-form'
import { getPathname, redirect } from '@/i18n/navigation'
import { auth, githubEnabled } from '@/lib/auth'
import { safeAuthReturn } from '@/lib/auth-return'

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale()
  const t = await getTranslations({ locale, namespace: 'Metadata' })
  return { title: t('signUpTitle'), description: t('signUpDescription') }
}

export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ next?: string; addAccount?: string }> }) {
  const query = await searchParams
  const next = safeAuthReturn(query.next)
  const addAccount = query.addAccount === '1'
  const session = await auth.api.getSession({ headers: await headers() })
  if (session?.user && !addAccount) {
    const locale = await getLocale()
    if (next.startsWith('/?')) plainRedirect(`${getPathname({ locale, href: '/' })}${next.slice(1)}`)
    redirect({ href: next, locale })
  }
  return <AuthForm addAccount={addAccount} next={next} mode="sign-up" githubEnabled={githubEnabled} />
}
