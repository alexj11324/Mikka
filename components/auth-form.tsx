'use client'

import { useState, type FormEvent } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { authClient } from '@/lib/auth-client'
import { getPathname } from '@/i18n/navigation'
import { Auth } from '@/components/blocks/auth-19/components/auth'
import { SignInCard } from '@/components/blocks/auth-19/components/sign-in-card'

export function AuthForm({ mode, githubEnabled = false, oauthFailed = false, continueGitHub = false, callbackURL }: { mode: 'sign-in' | 'sign-up'; githubEnabled?: boolean; oauthFailed?: boolean; continueGitHub?: boolean; callbackURL?: string }) {
  const t = useTranslations('Auth')
  const locale = useLocale()
  const home = getPathname({ locale, href: '/' })
  const signIn = getPathname({ locale, href: '/sign-in' })
  const [error, setError] = useState(oauthFailed ? t('oauthFailed') : '')
  const [notice, setNotice] = useState(continueGitHub ? t('continueNotice') : '')
  async function signInWithGitHub() {
    if (pending || !githubEnabled) return
    if (window.self !== window.top) {
      const tab = window.open(`${signIn}?continue=github`, '_blank')
      if (tab) tab.opener = null
      setNotice(tab ? t('tabOpened') : t('tabBlocked'))
      return
    }
    setPending(true); setError(''); setNotice('')
    try {
      const result = await authClient.signIn.social({ provider: 'github', callbackURL: home, errorCallbackURL: `${signIn}?oauth=failed`, disableRedirect: true })
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
  return <Auth registering={registering}>
    <SignInCard registering={registering} pending={pending} githubEnabled={githubEnabled} error={error} notice={notice} callbackURL={callbackURL} onSubmit={submit} onGitHubSignIn={signInWithGitHub} />
  </Auth>
}
