import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect as plainRedirect } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'

import { AuthForm } from '@/components/auth-form'
import { emailSignInEnabled } from '@/lib/email-sign-in'
import { getPathname, redirect } from '@/i18n/navigation'
import { auth, oauthCallbackBaseURL, githubEnabled, googleEnabled } from '@/lib/auth'
import { BASE_PATH, withBasePath } from '@/lib/base-path'
import { COMPOSIO_AUTH_CALLBACK_PATH, safeAuthReturn } from '@/lib/auth-return'
import { oauthAccountNotLinkedProvider } from '@/lib/auth-error'
import { authCallbackURL } from '@/lib/auth-callback'

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale()
  const t = await getTranslations({ locale, namespace: 'Metadata' })
  return { title: t('signUpTitle'), description: t('signUpDescription') }
}

export default async function SignUpPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams
  const next = safeAuthReturn(typeof query.next === 'string' ? query.next : undefined)
  const addAccount = query.addAccount === '1'
  const composioResume = next === COMPOSIO_AUTH_CALLBACK_PATH ? withBasePath(next) : undefined
  const session = await auth.api.getSession({ headers: await headers() })
  if (session?.user && !addAccount) {
    if (composioResume) plainRedirect(composioResume)
    const locale = await getLocale()
    if (next.startsWith('/?')) plainRedirect(`${getPathname({ locale, href: '/' })}${next.slice(1)}`)
    redirect({ href: next, locale })
  }
  return <AuthForm emailEnabled={await emailSignInEnabled()} addAccount={addAccount} next={next} mode="sign-up" googleEnabled={googleEnabled} githubEnabled={githubEnabled} oauthFailed={query.oauth === 'failed' || Boolean(query.error)} oauthAccountNotLinked={oauthAccountNotLinkedProvider(query.error, query.provider)} continueComposio={Boolean(composioResume)} continueURL={composioResume} googleCallbackURL={authCallbackURL(oauthCallbackBaseURL, 'google', BASE_PATH)} githubCallbackURL={authCallbackURL(oauthCallbackBaseURL, 'github', BASE_PATH)} />
}
