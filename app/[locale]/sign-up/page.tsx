import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect as plainRedirect } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'

import { AuthForm } from '@/components/auth-form'
import { getPathname, redirect } from '@/i18n/navigation'
import { auth, authBaseURL, githubEnabled, googleEnabled } from '@/lib/auth'
import { BASE_PATH } from '@/lib/base-path'
import { safeAuthReturn } from '@/lib/auth-return'
import { authCallbackURL } from '@/lib/auth-callback'

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale()
  const t = await getTranslations({ locale, namespace: 'Metadata' })
  return { title: t('signUpTitle'), description: t('signUpDescription') }
}

export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const query = await searchParams
  const next = safeAuthReturn(query.next)
  const session = await auth.api.getSession({ headers: await headers() })
  if (session?.user) {
    const locale = await getLocale()
    if (next.startsWith('/?')) plainRedirect(`${getPathname({ locale, href: '/' })}${next.slice(1)}`)
    redirect({ href: next, locale })
  }
  return <AuthForm next={next} mode="sign-up" googleEnabled={googleEnabled} githubEnabled={githubEnabled} googleCallbackURL={authCallbackURL(authBaseURL, 'google', BASE_PATH)} githubCallbackURL={authCallbackURL(authBaseURL, 'github', BASE_PATH)} />
}
