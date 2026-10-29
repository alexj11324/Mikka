'use client'

import { useRef, useState, type FormEvent } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { authClient } from '@/lib/auth-client'
import { getPathname } from '@/i18n/navigation'
import { Auth } from '@/components/blocks/auth-19/components/auth'
import { SignInCard } from '@/components/blocks/auth-19/components/sign-in-card'
import { safeAuthReturn } from '@/lib/auth-return'
import { withBasePath } from '@/lib/base-path'
import { desktopAuthReturnPath } from '@/lib/desktop-auth'
import { bridgeFromWindow } from '@/lib/platform/detect'
import { Button } from '@/components/ui/button'
import { listIssues, saveIssue } from '@/app/actions/issues'

const DESKTOP_OAUTH_STATE_KEY = 'mikka:desktop-oauth'
const DESKTOP_OAUTH_TTL_MS = 10 * 60_000

type DesktopFlow = { state: string; next: string }

function newDesktopState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function rememberDesktopState(state: string): void {
  try {
    sessionStorage.setItem(DESKTOP_OAUTH_STATE_KEY, JSON.stringify({ state, expires: Date.now() + DESKTOP_OAUTH_TTL_MS }))
  } catch {
    // Without sessionStorage the finish page refuses the state. Reloading the
    // sign-in page and trying again is the recovery path.
  }
}

export function AuthForm({ mode, addAccount = false, googleEnabled = false, githubEnabled = false, oauthFailed = false, oauthAccountNotLinked, continueGoogle = false, continueGitHub = false, continueComposio = false, googleCallbackURL, githubCallbackURL, testWorkspaceEnabled = false, next, continueURL, desktopFlow = null }: { mode: 'sign-in' | 'sign-up'; addAccount?: boolean; googleEnabled?: boolean; githubEnabled?: boolean; oauthFailed?: boolean; oauthAccountNotLinked?: 'google' | 'github' | null; continueGoogle?: boolean; continueGitHub?: boolean; continueComposio?: boolean; googleCallbackURL?: string; githubCallbackURL?: string; testWorkspaceEnabled?: boolean; next?: string; continueURL?: string; desktopFlow?: DesktopFlow | null }) {
  const t = useTranslations('Auth')
  const locale = useLocale()
  const returnPath = safeAuthReturn(next)
  // Used for full-page navigations and OAuth callbacks, so they carry the base path.
  // An agent's OAuth sign-in (continueURL) goes back to its authorize request instead.
  const home = continueURL ?? withBasePath(returnPath.startsWith('/?')
    ? `${getPathname({ locale, href: '/' })}${returnPath.slice(1)}`
    : getPathname({ locale, href: returnPath }))
  // A desktop browser handoff must come back to the app, not stay in the browser.
  const afterSignIn = desktopFlow ? desktopAuthReturnPath(desktopFlow.state, desktopFlow.next) : home
  function desktopSignInURL(state: string, next: string): string {
    const target = new URL(withBasePath(getPathname({ locale, href: '/sign-in' })), window.location.origin)
    target.search = new URLSearchParams({ desktop: '1', desktop_state: state, desktop_next: next }).toString()
    return target.toString()
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
      if (typeof bridge.app.openExternal !== 'function') {
        setError(t('browserUpdateRequired'))
        return
      }
      if (!beginSubmit()) return
      try {
        // OAuth state must be created in the browser that completes it, so the
        // desktop opens the web sign-in page in the system browser. The app
        // keeps the nonce and receives the result through mikka-desktop://.
        const state = newDesktopState()
        rememberDesktopState(state)
        await bridge.app.openExternal(desktopSignInURL(state, returnPath))
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
      const callbackURL = desktopFlow ? desktopAuthReturnPath(desktopFlow.state, desktopFlow.next) : home
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
      if (typeof bridge.app.openExternal !== 'function') {
        setError(t('browserUpdateRequired'))
        return
      }
      if (!beginSubmit()) return
      try {
        const state = newDesktopState()
        rememberDesktopState(state)
        await bridge.app.openExternal(desktopSignInURL(state, returnPath))
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
      const callbackURL = desktopFlow ? desktopAuthReturnPath(desktopFlow.state, desktopFlow.next) : home
      const result = await authClient.signIn.social({ provider: 'github', callbackURL, errorCallbackURL: oauthErrorCallbackURL('github'), disableRedirect: true })
      if (result.error || !result.data?.url) throw new Error('OAuth initiation failed')
      window.location.assign(result.data.url)
    } catch {
      setError(t('githubStartFailed'))
      endSubmit()
    }
  }
  const registering = mode === 'sign-up'
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!beginSubmit()) return
    const data = new FormData(event.currentTarget)
    try {
      const credentials = { email: String(data.get('email')).trim(), password: String(data.get('password')) }
      const result = registering ? await authClient.signUp.email({ ...credentials, name: String(data.get('name')).trim() }) : await authClient.signIn.email(credentials)
      if (result.error) { setError(t('submitFailed')); return }
      const session = await authClient.getSession({ query: { disableCookieCache: true } })
      if (!session.data?.user) { setError(t('sessionNotKept')); return }
      window.location.replace(afterSignIn)
    } catch { setError(t('connectionFailed')) }
    finally { endSubmit() }
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
    <SignInCard registering={registering} addAccount={addAccount} pending={pending} googleEnabled={googleEnabled} githubEnabled={githubEnabled} showGoogleLinkHint={Boolean(error && googleEnabled)} error={error} notice={notice} googleCallbackURL={googleCallbackURL} githubCallbackURL={githubCallbackURL} next={returnPath} onSubmit={submit} onGoogleSignIn={signInWithGoogle} onGitHubSignIn={signInWithGitHub} />
    {testWorkspaceEnabled && !registering && <div className="flex flex-col items-center gap-2">
      <Button type="button" variant="outline" disabled={pending} onClick={enterTestWorkspace}>{t('testWorkspaceCta')}</Button>
      <p className="text-muted-foreground text-xs">{t('testWorkspaceHint')}</p>
    </div>}
  </Auth>
}
