import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { getLocale, getTranslations } from 'next-intl/server'

import { AuthForm } from '@/components/auth-form'
import { redirect } from '@/i18n/navigation'
import { auth, authBaseURL, githubEnabled } from '@/lib/auth'

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale()
  const t = await getTranslations({ locale, namespace: 'Metadata' })
  return { title: t('signInTitle'), description: t('signInDescription') }
}

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ oauth?: string; continue?: string }> }) {
  const query = await searchParams
  const session = await auth.api.getSession({ headers: await headers() })
  if (session?.user) redirect({ href: '/', locale: await getLocale() })
  return <AuthForm mode="sign-in" githubEnabled={githubEnabled} oauthFailed={query.oauth === 'failed' || Boolean((query as Record<string, string>).error)} continueGitHub={query.continue === 'github'} callbackURL={authBaseURL ? `${authBaseURL.replace(/\/$/, '')}/api/auth/callback/github` : undefined} />
}
