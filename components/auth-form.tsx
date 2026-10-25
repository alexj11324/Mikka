'use client'

import { useRef, useState, type FormEvent } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { authClient } from '@/lib/auth-client'
import { getPathname } from '@/i18n/navigation'
import { Auth } from '@/components/blocks/auth-19/components/auth'
import { SignInCard } from '@/components/blocks/auth-19/components/sign-in-card'
import { safeAuthReturn } from '@/lib/auth-return'
import { isEmailNotVerified, recoveryMessageKey, sendVerificationEmail } from '@/lib/auth-recovery'
import { withBasePath } from '@/lib/base-path'
import { Button } from '@/components/ui/button'
import { listIssues, saveIssue } from '@/app/actions/issues'

export function AuthForm({ mode, addAccount = false, googleEnabled = false, githubEnabled = false, oauthFailed = false, oauthAccountNotLinked, continueGoogle = false, continueGitHub = false, continueComposio = false, googleCallbackURL, githubCallbackURL, testWorkspaceEnabled = false, next, continueURL }: { mode: 'sign-in' | 'sign-up'; addAccount?: boolean; googleEnabled?: boolean; githubEnabled?: boolean; oauthFailed?: boolean; oauthAccountNotLinked?: 'google' | 'github' | null; continueGoogle?: boolean; continueGitHub?: boolean; continueComposio?: boolean; googleCallbackURL?: string; githubCallbackURL?: string; testWorkspaceEnabled?: boolean; next?: string; continueURL?: string }) {
  const t = useTranslations('Auth')
  const locale = useLocale()
  const returnPath = safeAuthReturn(next)
  // Used for full-page navigations and OAuth callbacks, so they carry the base path.
  // An agent's OAuth sign-in (continueURL) goes back to its authorize request instead.
  const home = continueURL ?? withBasePath(returnPath.startsWith('/?')
    ? `${getPathname({ locale, href: '/' })}${returnPath.slice(1)}`
    : getPathname({ locale, href: returnPath }))
  const [error, setError] = useState(oauthAccountNotLinked === 'google' ? t('googleAccountNotLinked') : oauthAccountNotLinked === 'github' ? t('githubAccountNotLinked') : oauthFailed ? t('oauthFailed') : '')
  const [notice, setNotice] = useState(continueGoogle || continueGitHub || continueComposio ? t('continueNotice') : '')
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
  const [unverifiedEmail, setUnverifiedEmail] = useState('')
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
    if (!beginSubmit()) return
    try {
      const result = await authClient.signIn.social({ provider: 'google', callbackURL: home, errorCallbackURL: oauthErrorCallbackURL('google'), disableRedirect: true })
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
    if (!beginSubmit()) return
    try {
      const result = await authClient.signIn.social({ provider: 'github', callbackURL: home, errorCallbackURL: oauthErrorCallbackURL('github'), disableRedirect: true })
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
      setUnverifiedEmail('')
      if (!registering && isEmailNotVerified(result.error)) { setUnverifiedEmail(credentials.email); setError(t('emailNotVerified')); return }
      if (result.error) { setError(t('submitFailed')); return }
      const session = await authClient.getSession({ query: { disableCookieCache: true } })
      if (!session.data?.user) { setError(t('sessionNotKept')); return }
      window.location.replace(home)
    } catch { setError(t('connectionFailed')) }
    finally { endSubmit() }
  }
  async function resendVerification() {
    if (!beginSubmit()) return
    try {
      const callbackURL = new URL(withBasePath(getPathname({ locale, href: '/verify-email' })), window.location.origin).href
      const result = await sendVerificationEmail({ email: unverifiedEmail, callbackURL })
      if (result.ok) setNotice(t('verificationSent'))
      else setError(t(recoveryMessageKey(result.error)))
    } catch {
      setError(t('connectionFailed'))
    } finally {
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
      window.location.replace(home)
    } catch {
      setError(t('testWorkspaceFailed'))
    } finally {
      endSubmit()
    }
  }
  return <Auth registering={registering} addAccount={addAccount} next={returnPath}>
    <SignInCard registering={registering} addAccount={addAccount} pending={pending} googleEnabled={googleEnabled} githubEnabled={githubEnabled} showGoogleLinkHint={Boolean(error && googleEnabled)} error={error} notice={notice} googleCallbackURL={googleCallbackURL} githubCallbackURL={githubCallbackURL} next={returnPath} onSubmit={submit} onGoogleSignIn={signInWithGoogle} onGitHubSignIn={signInWithGitHub} onResendVerification={unverifiedEmail ? () => void resendVerification() : undefined} />
    {testWorkspaceEnabled && !registering && <div className="flex flex-col items-center gap-2">
      <Button type="button" variant="outline" disabled={pending} onClick={enterTestWorkspace}>{t('testWorkspaceCta')}</Button>
      <p className="text-muted-foreground text-xs">{t('testWorkspaceHint')}</p>
    </div>}
  </Auth>
}
