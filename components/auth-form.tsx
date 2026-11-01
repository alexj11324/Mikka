'use client'

import { useRef, useState, type FormEvent } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { authClient } from '@/lib/auth-client'
import { getPathname } from '@/i18n/navigation'
import { Auth } from '@/components/blocks/auth-19/components/auth'
import { SignInCard } from '@/components/blocks/auth-19/components/sign-in-card'
import { safeAuthReturn } from '@/lib/auth-return'
import { withBasePath } from '@/lib/base-path'
import { desktopAuthCallbackURL, desktopAuthReturnPath } from '@/lib/desktop-auth'
import { bridgeFromWindow } from '@/lib/platform/detect'
import { Button } from '@/components/ui/button'
import { listIssues, saveIssue } from '@/app/actions/issues'
import { signupRefusal, turnstileHeaders } from '@/lib/signup-refusal'
import { Turnstile, type TurnstileHandle } from '@/components/auth/turnstile'

const DESKTOP_OAUTH_STATE_KEY = 'mikka:desktop-oauth'
const DESKTOP_OAUTH_TTL_MS = 10 * 60_000

type DesktopFlow = { state: string; next: string; callback: string | null }

function newDesktopState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** A PKCE-style pair: the verifier stays in this window, the server only sees its S256 challenge. */
async function newDesktopVerifier(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  return { verifier, challenge: base64url(digest) }
}

function rememberDesktopState(state: string, verifier: string): void {
  try {
    sessionStorage.setItem(DESKTOP_OAUTH_STATE_KEY, JSON.stringify({ state, verifier, expires: Date.now() + DESKTOP_OAUTH_TTL_MS }))
  } catch {
    // Without sessionStorage the finish page refuses the state. Reloading the
    // sign-in page and trying again is the recovery path.
  }
}

export function AuthForm({ mode, addAccount = false, googleEnabled = false, githubEnabled = false, oauthFailed = false, oauthAccountNotLinked, continueGoogle = false, continueGitHub = false, continueComposio = false, testWorkspaceEnabled = false, emailEnabled = true, next, continueURL, desktopFlow = null }: { mode: 'sign-in' | 'sign-up'; addAccount?: boolean; googleEnabled?: boolean; githubEnabled?: boolean; oauthFailed?: boolean; oauthAccountNotLinked?: 'google' | 'github' | null; continueGoogle?: boolean; continueGitHub?: boolean; continueComposio?: boolean; testWorkspaceEnabled?: boolean; emailEnabled?: boolean; next?: string; continueURL?: string; desktopFlow?: DesktopFlow | null }) {
  const t = useTranslations('Auth')
  const locale = useLocale()
  const returnPath = safeAuthReturn(next)
  // Used for full-page navigations and OAuth callbacks, so they carry the base path.
  // An agent's OAuth sign-in (continueURL) goes back to its authorize request instead.
  const home = continueURL ?? withBasePath(returnPath.startsWith('/?')
    ? `${getPathname({ locale, href: '/' })}${returnPath.slice(1)}`
    : getPathname({ locale, href: returnPath }))
  // A desktop browser handoff must come back to the app, not stay in the browser.
  const afterSignIn = desktopFlow ? desktopAuthReturnPath(desktopFlow.state, desktopFlow.next, desktopFlow.callback) : home
  function desktopSignInURL(state: string, next: string, callback: string): string {
    const target = new URL(withBasePath(getPathname({ locale, href: '/sign-in' })), window.location.origin)
    target.search = new URLSearchParams({ desktop: '1', desktop_state: state, desktop_next: next, desktop_callback: callback }).toString()
    return target.toString()
  }
  async function beginDesktopAuth(bridge: NonNullable<ReturnType<typeof bridgeFromWindow>>): Promise<void> {
    // Works signed out: the server keeps an unbound request that the browser
    // binds after OAuth, and only this window holds the verifier to claim it.
    const state = newDesktopState()
    const { verifier, challenge } = await newDesktopVerifier()
    rememberDesktopState(state, verifier)
    const callback = await bridge.app.prepareAuth(state)
    const response = await fetch(withBasePath('/api/desktop/begin'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, callback, challenge }),
    })
    if (!response.ok) throw new Error('desktop handoff registration failed')
    await bridge.app.openExternal(desktopSignInURL(state, returnPath, callback))
  }
  const [error, setError] = useState(oauthAccountNotLinked === 'google' ? t('googleAccountNotLinked') : oauthAccountNotLinked === 'github' ? t('githubAccountNotLinked') : oauthFailed ? t('oauthFailed') : '')
  const [notice, setNotice] = useState(desktopFlow || continueGoogle || continueGitHub || continueComposio ? t('continueNotice') : '')
  function oauthErrorCallbackURL(provider: 'google' | 'github') {
    const url = new URL(window.location.href)
    url.searchParams.delete('error')
    url.searchParams.delete('error_description')
    url.searchParams.delete('error_uri')
    url.searchParams.set('oauth', 'failed')
    url.searchParams.set('provider', provider)
    return url.toString()
  }
  const pendingRef = useRef(false)
  const [pending, setPending] = useState(false)
  function beginSubmit() {
    if (pendingRef.current) return false
    pendingRef.current = true
    setPending(true)
    setError('')
    setNotice('')
    return true
  }
  function endSubmit() {
    pendingRef.current = false
    setPending(false)
  }
  async function signInWithGoogle() {
    if (!googleEnabled) return
    if (window.self !== window.top) {
      const tab = window.open(window.location.href, '_blank')
      if (tab) tab.opener = null
      setNotice(tab ? t('tabOpened') : t('tabBlocked'))
      return
    }
    const bridge = bridgeFromWindow(window)
    if (bridge) {
      // An older shell predates the system-browser bridge. Fail closed rather
      // than render Google's OAuth page in the embedded window.
      if (typeof bridge.app.prepareAuth !== 'function') {
        setError(t('browserUpdateRequired'))
        return
      }
      if (!beginSubmit()) return
      try {
        // OAuth state must be created in the browser that completes it, so the
        // desktop opens the web sign-in page in the system browser. The app
        // keeps the nonce and receives the result through a loopback callback.
        await beginDesktopAuth(bridge)
        setNotice(t('browserOpened'))
      } catch {
        setError(t('browserFailed'))
      } finally {
        endSubmit()
      }
      return
    }
    if (!beginSubmit()) return
    try {
      const callbackURL = desktopFlow ? desktopAuthCallbackURL(window.location.origin, desktopFlow.state, desktopFlow.next, desktopFlow.callback) : home
      const result = await authClient.signIn.social({ provider: 'google', callbackURL, errorCallbackURL: oauthErrorCallbackURL('google'), disableRedirect: true })
      if (result.error || !result.data?.url) throw new Error('OAuth initiation failed')
      window.location.assign(result.data.url)
    } catch {
      setError(t('googleStartFailed'))
      endSubmit()
    }
  }
  async function signInWithGitHub() {
    if (!githubEnabled) return
    if (window.self !== window.top) {
      const tab = window.open(window.location.href, '_blank')
      if (tab) tab.opener = null
      setNotice(tab ? t('tabOpened') : t('tabBlocked'))
      return
    }
    const bridge = bridgeFromWindow(window)
    if (bridge) {
      // An older shell predates the system-browser bridge. Fail closed rather
      // than render Google's OAuth page in the embedded window.
      if (typeof bridge.app.prepareAuth !== 'function') {
        setError(t('browserUpdateRequired'))
        return
      }
      if (!beginSubmit()) return
      try {
        await beginDesktopAuth(bridge)
        setNotice(t('browserOpened'))
      } catch {
        setError(t('browserFailed'))
      } finally {
        endSubmit()
      }
      return
    }
    if (!beginSubmit()) return
    try {
      const callbackURL = desktopFlow ? desktopAuthCallbackURL(window.location.origin, desktopFlow.state, desktopFlow.next, desktopFlow.callback) : home
      const result = await authClient.signIn.social({ provider: 'github', callbackURL, errorCallbackURL: oauthErrorCallbackURL('github'), disableRedirect: true })
      if (result.error || !result.data?.url) throw new Error('OAuth initiation failed')
      window.location.assign(result.data.url)
    } catch {
      setError(t('githubStartFailed'))
      endSubmit()
    }
  }
  const registering = mode === 'sign-up'
  const turnstile = useRef<TurnstileHandle>(null)
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!beginSubmit()) return
    const data = new FormData(event.currentTarget)
    try {
      const credentials = { email: String(data.get('email')).trim(), password: String(data.get('password')) }
      const result = registering
        ? await authClient.signUp.email({ ...credentials, name: String(data.get('name')).trim(), fetchOptions: { headers: turnstileHeaders(turnstileToken) } })
        : await authClient.signIn.email(credentials)
      if (result.error) {
        const refusal = registering ? signupRefusal(result.error.status, result.error.code) : null
        setError(refusal ? t(`signupRefusal.${refusal}`) : t('submitFailed'))
        return
      }
      const session = await authClient.getSession({ query: { disableCookieCache: true } })
      if (!session.data?.user) { setError(t('sessionNotKept')); return }
      window.location.replace(afterSignIn)
    } catch { setError(t('connectionFailed')) }
    finally {
      // A Turnstile token is single-use, accepted or not.
      if (registering) turnstile.current?.reset()
      endSubmit()
    }
  }
  async function enterTestWorkspace() {
    if (!beginSubmit()) return
    try {
      const response = await fetch(withBasePath('/api/test-workspace'), { method: 'POST' })
      if (!response.ok) throw new Error('Test workspace unavailable')
      const session = await authClient.getSession({ query: { disableCookieCache: true } })
      if (!session.data?.user) {
        setError(t('testWorkspaceSessionFailed'))
        return
      }
      const existing = await listIssues()
      const fixtures = [
        { title: t('testIssueLayoutTitle'), description: t('testIssueLayoutDescription') },
        { title: t('testIssueSwitchTitle'), description: t('testIssueSwitchDescription') },
      ]
      for (const fixture of fixtures) {
        if (existing.some(issue => issue.title === fixture.title)) continue
        const result = await saveIssue({ title: fixture.title, status: 'todo', priority: 'normal', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: fixture.description }] }] } })
        if (result.error) throw new Error('Test task initialization failed')
      }
      window.location.replace(afterSignIn)
    } catch {
      setError(t('testWorkspaceFailed'))
    } finally {
      endSubmit()
    }
  }
  return <Auth registering={registering} addAccount={addAccount} next={returnPath}>
    <SignInCard registering={registering} addAccount={addAccount} pending={pending} googleEnabled={googleEnabled} githubEnabled={githubEnabled} emailEnabled={emailEnabled} showGoogleLinkHint={Boolean(error && googleEnabled)} error={error} notice={notice} next={returnPath} onSubmit={submit} onGoogleSignIn={signInWithGoogle} onGitHubSignIn={signInWithGitHub} turnstile={registering ? <Turnstile ref={turnstile} onToken={setTurnstileToken} /> : undefined} />
    {testWorkspaceEnabled && !registering && <div className="flex flex-col items-center gap-2">
      <Button type="button" variant="outline" disabled={pending} onClick={enterTestWorkspace}>{t('testWorkspaceCta')}</Button>
      <p className="text-muted-foreground text-xs">{t('testWorkspaceHint')}</p>
    </div>}
  </Auth>
}
