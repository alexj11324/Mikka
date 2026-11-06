import { useRef, useState, type FormEvent } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Auth } from '@/components/blocks/auth-19/components/auth'
import { SignInCard } from '@/components/blocks/auth-19/components/sign-in-card'
import { safeAuthReturn } from '@/lib/auth-return'
import { signInRefusal } from '@/lib/signup-refusal'
import { rendererHost } from './host'
import { navigate, refresh } from './location'

/** The web and desktop render the very same Auth and SignInCard. Only event
 * handlers differ: PKCE and bearer sessions are owned exclusively by main. */
export function AuthForm({ mode, addAccount = false, googleEnabled = false, githubEnabled = false, emailEnabled = true, next, oauthFailed = false }: {
  mode: 'sign-in' | 'sign-up'
  addAccount?: boolean
  googleEnabled?: boolean
  githubEnabled?: boolean
  emailEnabled?: boolean
  next?: string
  oauthFailed?: boolean
  /** The web's desktop-handoff account choice; the app's own window never shows it. */
  signedInAs?: { name?: string | null; email: string; image?: string | null } | null
}) {
  const t = useTranslations('Auth')
  const locale = useLocale() === 'en' ? 'en' : 'zh-CN'
  const returnPath = safeAuthReturn(next)
  const registering = mode === 'sign-up'
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)
  const [error, setError] = useState(oauthFailed ? t('oauthFailed') : '')
  const [notice, setNotice] = useState('')
  const [unverified, setUnverified] = useState(false)
  function begin() {
    if (pendingRef.current) return false
    pendingRef.current = true
    setPending(true); setError(''); setNotice(''); setUnverified(false)
    return true
  }
  function done() { pendingRef.current = false; setPending(false) }
  async function social(provider: 'google' | 'github') {
    if (!begin()) return
    try {
      await rendererHost().signIn({ provider, next: returnPath, locale, addAccount })
      setNotice(t('browserOpened'))
    } catch { setError(t('browserFailed')) }
    finally { done() }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!begin()) return
    const form = event.currentTarget
    const input = new FormData(form)
    try {
      // A typed password is handed over once, never persisted by either renderer
      // storage or the IPC result. The session response itself stays in main.
      const result = await rendererHost().signInEmail({
        email: String(input.get('email') ?? '').trim(),
        password: String(input.get('password') ?? ''),
      })
      if (result) {
        const refusal = signInRefusal(result.status ?? 400, result.code)
        setError(refusal ? t(`signInRefusal.${refusal}`) : t('submitFailed'))
        setUnverified(refusal === 'emailNotVerified')
        return
      }
      form.reset()
      navigate(returnPath, true, { locale }, true)
      refresh()
    } catch { setError(t('connectionFailed')) }
    finally { done() }
  }
  return <Auth registering={registering} addAccount={addAccount} next={returnPath}>
    <SignInCard registering={registering} addAccount={addAccount} pending={pending} googleEnabled={googleEnabled} githubEnabled={githubEnabled} emailEnabled={emailEnabled} showGoogleLinkHint={Boolean(error && googleEnabled)} error={error} unverified={Boolean(error) && unverified} notice={notice} next={returnPath} onSubmit={submit} onGoogleSignIn={() => social('google')} onGitHubSignIn={() => social('github')} />
  </Auth>
}
