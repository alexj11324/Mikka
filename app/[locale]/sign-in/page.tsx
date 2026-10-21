import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'

import { AuthForm } from '@/components/auth-form'
import { redirect as localeRedirect } from '@/i18n/navigation'
import { isAcceptanceEnabled } from '@/lib/acceptance'
import { auth, authBaseURL, githubEnabled } from '@/lib/auth'
import { safeAuthReturn } from '@/lib/auth-return'

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale()
  const t = await getTranslations({ locale, namespace: 'Metadata' })
  return { title: t('signInTitle'), description: t('signInDescription') }
}

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ oauth?: string; continue?: string; login?: string; error?: string; next?: string }> }) {
  const query = await searchParams
  const next = safeAuthReturn(query.next)
  const session = await auth.api.getSession({ headers: await headers() })
  if (session?.user) localeRedirect({ href: next, locale: await getLocale() })
  if (isAcceptanceEnabled() && query.login !== '1' && !query.oauth && !query.continue && !query.error && !query.next) redirect('/api/acceptance')
  return <AuthForm next={next} mode="sign-in" githubEnabled={githubEnabled} oauthFailed={query.oauth === 'failed' || Boolean(query.error)} continueGitHub={query.continue === 'github'} callbackURL={authBaseURL ? `${authBaseURL.replace(/\/$/, '')}/api/auth/callback/github` : undefined} />
}
