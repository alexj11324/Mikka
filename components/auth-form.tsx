'use client'

import { useState, type FormEvent } from 'react'
import { authClient } from '@/lib/auth-client'
import { Auth } from '@/components/blocks/auth-19/components/auth'
import { SignInCard } from '@/components/blocks/auth-19/components/sign-in-card'

export function AuthForm({ mode, githubEnabled = false, oauthFailed = false, continueGitHub = false, callbackURL }: { mode: 'sign-in' | 'sign-up'; githubEnabled?: boolean; oauthFailed?: boolean; continueGitHub?: boolean; callbackURL?: string }) {
  const [error, setError] = useState(oauthFailed ? 'GitHub 登录未完成，可能已取消或授权已过期。请重新尝试。' : '')
  const [notice, setNotice] = useState(continueGitHub ? '请点击下方按钮，在此标签页完成 GitHub 授权。' : '')
  async function signInWithGitHub() {
    if (pending || !githubEnabled) return
    if (window.self !== window.top) {
      const tab = window.open('/sign-in?continue=github', '_blank')
      if (tab) tab.opener = null
      setNotice(tab ? '请在新标签页点击 GitHub 登录并完成授权；完成后可刷新此预览。' : '浏览器阻止了新标签页，请允许弹出窗口后重试。')
      return
    }
    setPending(true); setError(''); setNotice('')
    try {
      const result = await authClient.signIn.social({ provider: 'github', callbackURL: '/', errorCallbackURL: '/sign-in?oauth=failed', disableRedirect: true })
      if (result.error || !result.data?.url) throw new Error('OAuth initiation failed')
      window.location.assign(result.data.url)
    } catch {
      setError('暂时无法开始 GitHub 登录，请稍后重试。')
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
      if (result.error) { setError('操作未成功，请检查填写的信息或稍后重试。'); return }
      const session = await authClient.getSession({ query: { disableCookieCache: true } })
      if (!session.data?.user) { setError('登录已响应，但浏览器未能保持会话。请允许此预览的第三方 Cookie，或在独立标签页打开后登录。'); return }
      window.location.replace('/')
    } catch { setError('暂时无法连接，请稍后重试。') }
    finally { setPending(false) }
  }
  return <Auth registering={registering}>
    <SignInCard registering={registering} pending={pending} githubEnabled={githubEnabled} error={error} notice={notice} callbackURL={callbackURL} onSubmit={submit} onGitHubSignIn={signInWithGitHub} />
  </Auth>
}
