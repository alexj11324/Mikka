import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'

import { AuthForm } from '@/components/auth-form'
import { ClearUnauthenticatedReadCache } from '@/components/authenticated-read-cache'
import { emailSignInEnabled } from '@/lib/email-sign-in'
import { getPathname, redirect as localeRedirect } from '@/i18n/navigation'
import { isAcceptanceEnabled } from '@/lib/acceptance'
import { auth, githubSignInEnabled, googleEnabled } from '@/lib/auth'
import { withBasePath } from '@/lib/base-path'
import { COMPOSIO_AUTH_CALLBACK_PATH, oauthResumePath, safeAuthReturn } from '@/lib/auth-return'
import { oauthAccountNotLinkedProvider } from '@/lib/auth-error'
import { webAuthFlow } from '@/lib/web-connection/auth'
import { officialWebCallback } from '@/lib/web-connection/policy'
import { desktopAuthState, desktopLoopbackCallback } from '@/lib/desktop-auth'

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
  const parsedWebFlow = desktopFlow ? null : webAuthFlow(query)
  const webFlow = parsedWebFlow && officialWebCallback(parsedWebFlow.callback) ? parsedWebFlow : null
  const composioResume = !webFlow && next === COMPOSIO_AUTH_CALLBACK_PATH ? withBasePath(next) : undefined
  const oauthResume = webFlow ? null : oauthResumePath(query)
  const session = await auth.api.getSession({ headers: await headers() })
  if (session?.user && !addAccount && oauthResume) redirect(oauthResume)
  if (session?.user && !addAccount && composioResume) redirect(next)
  // The return route sends a refused handoff here with oauth=failed: show that, never redirect back to it.
  // A company SSO refusal comes back with sso=failed and its own error; the auth-sso slot shows it, so the generic
  // OAuth notice stays off for that one.
  const desktopRefused = Boolean((desktopFlow || webFlow) && query.oauth)
  // A desktop handoff with a web session shows the account first (AuthForm).
  if (session?.user && !addAccount && !desktopFlow && !webFlow) {
    const locale = await getLocale()
    if (next.startsWith('/?')) redirect(`${getPathname({ locale, href: '/' })}${next.slice(1)}`)
    localeRedirect({ href: next, locale })
  }
  if (isAcceptanceEnabled() && !addAccount && !desktopFlow && !webFlow && !oauthResume && !composioResume && query.login !== '1' && !query.oauth && !query.continue && !query.error && !query.next) redirect('/api/acceptance')
  return <>{!session?.user && <ClearUnauthenticatedReadCache />}<AuthForm emailEnabled={await emailSignInEnabled()} addAccount={addAccount} next={next} mode="sign-in" googleEnabled={googleEnabled} githubEnabled={await githubSignInEnabled()} oauthFailed={query.oauth === 'failed' || (Boolean(query.error) && query.sso !== 'failed')} continueGoogle={query.continue === 'google'} continueGitHub={query.continue === 'github'} oauthAccountNotLinked={oauthAccountNotLinkedProvider(query.error, query.provider)} continueComposio={Boolean(composioResume)} continueURL={oauthResume ? withBasePath(oauthResume) : composioResume} desktopFlow={desktopFlow} webFlow={webFlow} signedInAs={session?.user && (desktopFlow || webFlow) && !desktopRefused ? { name: session.user.name, email: session.user.email, image: session.user.image } : null} /></>
}
