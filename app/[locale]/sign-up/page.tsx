import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect as plainRedirect } from 'next/navigation'
import { getLocale, getTranslations } from 'next-intl/server'

import { AuthForm } from '@/components/auth-form'
import { emailSignInEnabled } from '@/lib/email-sign-in'
import { getPathname, redirect } from '@/i18n/navigation'
import { auth, githubSignInEnabled, googleEnabled } from '@/lib/auth'
import { withBasePath } from '@/lib/base-path'
import { COMPOSIO_AUTH_CALLBACK_PATH, safeAuthReturn } from '@/lib/auth-return'
import { oauthAccountNotLinkedProvider } from '@/lib/auth-error'
import { webAuthFlow } from '@/lib/web-connection/auth'
import { officialWebCallback } from '@/lib/web-connection/policy'
import { desktopAuthState, desktopLoopbackCallback } from '@/lib/desktop-auth'

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getLocale()
  const t = await getTranslations({ locale, namespace: 'Metadata' })
  return { title: t('signUpTitle'), description: t('signUpDescription') }
}

export default async function SignUpPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
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
  const session = await auth.api.getSession({ headers: await headers() })
  const desktopRefused = Boolean((desktopFlow || webFlow) && query.oauth)
  // A desktop handoff with a web session shows the account first (AuthForm).
  if (session?.user && !addAccount && !desktopFlow && !webFlow) {
    if (composioResume) plainRedirect(next)
    const locale = await getLocale()
    if (next.startsWith('/?')) plainRedirect(`${getPathname({ locale, href: '/' })}${next.slice(1)}`)
    redirect({ href: next, locale })
  }
  return <AuthForm emailEnabled={await emailSignInEnabled()} addAccount={addAccount} next={next} mode="sign-up" googleEnabled={googleEnabled} githubEnabled={await githubSignInEnabled()} oauthFailed={query.oauth === 'failed' || Boolean(query.error)} handoffRefused={desktopRefused} oauthAccountNotLinked={oauthAccountNotLinkedProvider(query.error, query.provider)} continueComposio={Boolean(composioResume)} continueURL={composioResume} desktopFlow={desktopFlow} webFlow={webFlow} signedInAs={session?.user && (desktopFlow || webFlow) && !desktopRefused ? { name: session.user.name, email: session.user.email, image: session.user.image } : null} />
}
