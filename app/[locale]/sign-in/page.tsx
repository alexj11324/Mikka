import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'

import { AuthForm } from '@/components/auth-form'
import { emailSignInEnabled } from '@/lib/email-sign-in'
import { getPathname, redirect as localeRedirect } from '@/i18n/navigation'
import { isAcceptanceEnabled } from '@/lib/acceptance'
import { auth, oauthCallbackBaseURL, githubEnabled, googleEnabled } from '@/lib/auth'
import { BASE_PATH, withBasePath } from '@/lib/base-path'
import { COMPOSIO_AUTH_CALLBACK_PATH, oauthResumePath, safeAuthReturn } from '@/lib/auth-return'
import { oauthAccountNotLinkedProvider } from '@/lib/auth-error'
import { authCallbackURL } from '@/lib/auth-callback'
import { desktopAuthCallbackPath, desktopAuthState, desktopLoopbackCallback } from '@/lib/desktop-auth'

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale()
  const t = await getTranslations({ locale, namespace: 'Metadata' })
  return { title: t('signInTitle'), description: t('signInDescription') }
}

export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams
  const next = safeAuthReturn(typeof query.next === 'string' ? query.next : undefined)
  const addAccount = query.addAccount === '1'
  const desktopState = desktopAuthState(query.desktop_state)
  const desktopCallback = desktopLoopbackCallback(query.desktop_callback)
  const desktopFlow = query.desktop === '1' && desktopState && desktopCallback
    ? { state: desktopState, next: safeAuthReturn(typeof query.desktop_next === 'string' ? query.desktop_next : undefined), callback: desktopCallback }
    : null
  const oauthResume = oauthResumePath(query)
  const composioResume = next === COMPOSIO_AUTH_CALLBACK_PATH ? withBasePath(next) : undefined
  const session = await auth.api.getSession({ headers: await headers() })
  if (session?.user && !addAccount && oauthResume) redirect(withBasePath(oauthResume))
  if (session?.user && !addAccount && composioResume) redirect(composioResume)
  // The return route sends a refused handoff here with oauth=failed: show that, never redirect back to it.
  const desktopRefused = Boolean(desktopFlow && query.oauth)
  if (session?.user && !addAccount && desktopFlow && !desktopRefused) redirect(desktopAuthCallbackPath(desktopFlow.state, desktopFlow.next, desktopFlow.callback))
  if (session?.user && !addAccount && !desktopRefused) {
    const locale = await getLocale()
    if (next.startsWith('/?')) redirect(`${getPathname({ locale, href: '/' })}${next.slice(1)}`)
    localeRedirect({ href: next, locale })
  }
  if (isAcceptanceEnabled() && !addAccount && !desktopFlow && !oauthResume && !composioResume && query.login !== '1' && !query.oauth && !query.continue && !query.error && !query.next) redirect('/api/acceptance')
  return <AuthForm emailEnabled={await emailSignInEnabled()} addAccount={addAccount} next={next} mode="sign-in" googleEnabled={googleEnabled} githubEnabled={githubEnabled} oauthFailed={query.oauth === 'failed' || Boolean(query.error)} continueGoogle={query.continue === 'google'} continueGitHub={query.continue === 'github'} oauthAccountNotLinked={oauthAccountNotLinkedProvider(query.error, query.provider)} continueComposio={Boolean(composioResume)} continueURL={oauthResume ? withBasePath(oauthResume) : composioResume} googleCallbackURL={authCallbackURL(oauthCallbackBaseURL, 'google', BASE_PATH)} githubCallbackURL={authCallbackURL(oauthCallbackBaseURL, 'github', BASE_PATH)} desktopFlow={desktopFlow} />
}
