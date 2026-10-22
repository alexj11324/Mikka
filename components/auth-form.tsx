'use client'

import { useState, type FormEvent } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { authClient } from '@/lib/auth-client'
import { getPathname } from '@/i18n/navigation'
import { Auth } from '@/components/blocks/auth-19/components/auth'
import { SignInCard } from '@/components/blocks/auth-19/components/sign-in-card'
import { safeAuthReturn } from '@/lib/auth-return'
import { withBasePath } from '@/lib/base-path'
import { Button } from '@/components/ui/button'
import { listIssues, saveIssue } from '@/app/actions/issues'

export function AuthForm({ mode, googleEnabled = false, githubEnabled = false, oauthFailed = false, continueGoogle = false, continueGitHub = false, continueComposio = false, googleCallbackURL, githubCallbackURL, testWorkspaceEnabled = false, next, continueURL }: { mode: 'sign-in' | 'sign-up'; googleEnabled?: boolean; githubEnabled?: boolean; oauthFailed?: boolean; continueGoogle?: boolean; continueGitHub?: boolean; continueComposio?: boolean; googleCallbackURL?: string; githubCallbackURL?: string; testWorkspaceEnabled?: boolean; next?: string; continueURL?: string }) {
  const t = useTranslations('Auth')
  const locale = useLocale()
  const returnPath = safeAuthReturn(next)
  // Used for full-page navigations and OAuth callbacks, so they carry the base path.
  // An agent's OAuth sign-in (continueURL) goes back to its authorize request instead.
  const home = continueURL ?? withBasePath(returnPath.startsWith('/?')
    ? `${getPathname({ locale, href: '/' })}${returnPath.slice(1)}`
    : getPathname({ locale, href: returnPath }))
  const [error, setError] = useState(oauthFailed ? t('oauthFailed') : '')
  const [notice, setNotice] = useState(continueGoogle || continueGitHub || continueComposio ? t('continueNotice') : '')
  function oauthErrorCallbackURL() {
    const url = new URL(window.location.href)
    url.searchParams.set('oauth', 'failed')
    return url.toString()
  }
  async function signInWithGoogle() {
    if (pending || !googleEnabled) return
    if (window.self !== window.top) {
      const tab = window.open(window.location.href, '_blank')
      if (tab) tab.opener = null
      setNotice(tab ? t('tabOpened') : t('tabBlocked'))
      return
    }
    setPending(true); setError(''); setNotice('')
    try {
      const result = await authClient.signIn.social({ provider: 'google', callbackURL: home, errorCallbackURL: oauthErrorCallbackURL(), disableRedirect: true })
      if (result.error || !result.data?.url) throw new Error('OAuth initiation failed')
      window.location.assign(result.data.url)
    } catch {
      setError(t('googleStartFailed'))
      setPending(false)
    }
  }
  async function signInWithGitHub() {
    if (pending || !githubEnabled) return
    if (window.self !== window.top) {
      const tab = window.open(window.location.href, '_blank')
      if (tab) tab.opener = null
      setNotice(tab ? t('tabOpened') : t('tabBlocked'))
      return
    }
    setPending(true); setError(''); setNotice('')
    try {
      const result = await authClient.signIn.social({ provider: 'github', callbackURL: home, errorCallbackURL: oauthErrorCallbackURL(), disableRedirect: true })
      if (result.error || !result.data?.url) throw new Error('OAuth initiation failed')
      window.location.assign(result.data.url)
    } catch {
      setError(t('githubStartFailed'))
      setPending(false)
    }
  }
  const [pending, setPending] = useState(false)
  const registering = mode === 'sign-up'
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    const data = new FormData(event.currentTarget)
    setPending(true); setError('')
    try {
      const credentials = { email: String(data.get('email')).trim(), password: String(data.get('password')) }
      const result = registering ? await authClient.signUp.email({ ...credentials, name: String(data.get('name')).trim() }) : await authClient.signIn.email(credentials)
      if (result.error) { setError(t('submitFailed')); return }
      const session = await authClient.getSession({ query: { disableCookieCache: true } })
      if (!session.data?.user) { setError(t('sessionNotKept')); return }
      window.location.replace(home)
    } catch { setError(t('connectionFailed')) }
    finally { setPending(false) }
  }
  async function enterTestWorkspace() {
    if (pending) return
    setPending(true); setError(''); setNotice('')
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
      window.location.replace(home)
    } catch {
      setError(t('testWorkspaceFailed'))
    } finally {
      setPending(false)
    }
  }
  return <Auth registering={registering} next={returnPath}>
    <SignInCard registering={registering} pending={pending} googleEnabled={googleEnabled} githubEnabled={githubEnabled} showGoogleLinkHint={Boolean(error && googleEnabled)} error={error} notice={notice} googleCallbackURL={googleCallbackURL} githubCallbackURL={githubCallbackURL} next={returnPath} onSubmit={submit} onGoogleSignIn={signInWithGoogle} onGitHubSignIn={signInWithGitHub} />
    {testWorkspaceEnabled && !registering && <div className="flex flex-col items-center gap-2">
      <Button type="button" variant="outline" disabled={pending} onClick={enterTestWorkspace}>{t('testWorkspaceCta')}</Button>
      <p className="text-muted-foreground text-xs">{t('testWorkspaceHint')}</p>
    </div>}
  </Auth>
}
