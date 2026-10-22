import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'

import { AuthForm } from '@/components/auth-form'
import { getPathname, redirect as localeRedirect } from '@/i18n/navigation'
import { isAcceptanceEnabled } from '@/lib/acceptance'
import { auth, authBaseURL, githubEnabled } from '@/lib/auth'
import { withBasePath } from '@/lib/base-path'
import { oauthResumePath, safeAuthReturn } from '@/lib/auth-return'

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale()
  const t = await getTranslations({ locale, namespace: 'Metadata' })
  return { title: t('signInTitle'), description: t('signInDescription') }
}

export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams
  const next = safeAuthReturn(typeof query.next === 'string' ? query.next : undefined)
  const addAccount = query.addAccount === '1'
  const oauthResume = oauthResumePath(query)
  const session = await auth.api.getSession({ headers: await headers() })
  if (session?.user && !addAccount && oauthResume) redirect(withBasePath(oauthResume))
  if (session?.user && !addAccount) {
    const locale = await getLocale()
    if (next.startsWith('/?')) redirect(`${getPathname({ locale, href: '/' })}${next.slice(1)}`)
    localeRedirect({ href: next, locale })
  }
  if (isAcceptanceEnabled() && !addAccount && !oauthResume && query.login !== '1' && !query.oauth && !query.continue && !query.error && !query.next) redirect('/api/acceptance')
  return <AuthForm addAccount={addAccount} next={next} mode="sign-in" githubEnabled={githubEnabled} oauthFailed={query.oauth === 'failed' || Boolean(query.error)} continueGitHub={query.continue === 'github'} continueURL={oauthResume ? withBasePath(oauthResume) : undefined} callbackURL={authBaseURL ? `${authBaseURL.replace(/\/$/, '')}${withBasePath('/api/auth/callback/github')}` : undefined} />
}
