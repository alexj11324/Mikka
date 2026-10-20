'use client'

import { useState, type FormEvent } from 'react'
import Link from 'next/link'
import { Command, ArrowRight } from 'lucide-react'
import { authClient } from '@/lib/auth-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Spinner } from '@/components/ui/spinner'
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible'

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
  return <main className="flex min-h-svh items-center justify-center bg-muted/20 px-6 py-12"><section className="flex w-full max-w-sm flex-col gap-8">
    <Link href="/" className="flex items-center gap-2 text-sm font-semibold"><Command className="size-5" />Orvilo2<span className="ml-auto text-xs font-normal text-muted-foreground">任务与文档，保持同步</span></Link>
    <div className="flex flex-col gap-2"><h1 className="text-2xl font-semibold tracking-tight">{registering ? '创建你的工作账号' : '回到你的工作台'}</h1><p className="text-sm leading-6 text-muted-foreground">{registering ? '从第一个任务开始，把想法变成可追踪的进展。' : '登录后继续编辑任务，查看已保存的文档版本。'}</p></div>
    <div className="flex flex-col gap-3"><Button type="button" disabled={pending || !githubEnabled} onClick={signInWithGitHub}>{pending ? <Spinner data-icon="inline-start" /> : <ArrowRight data-icon="inline-start" />}使用 GitHub 继续</Button><p className="text-xs leading-6 text-muted-foreground">{githubEnabled ? '仅获取登录所需的身份与邮箱，不请求仓库读写权限。预览中将在独立标签页继续。' : 'GitHub 登录待配置 Client ID 和 Client Secret；邮箱登录仍可使用。'}</p>{!githubEnabled && callbackURL && <Collapsible><CollapsibleTrigger className="cursor-pointer"><span className="text-xs text-muted-foreground">查看 GitHub App 回调地址</span></CollapsibleTrigger><CollapsibleContent><code className="mt-2 block break-all select-all text-xs text-muted-foreground">{callbackURL}</code></CollapsibleContent></Collapsible>}{notice && <p role="status" className="text-xs leading-6">{notice}</p>}</div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <form method="post" onSubmit={submit} className="flex flex-col gap-5"><FieldGroup>
      {registering && <Field><FieldLabel htmlFor="name">称呼</FieldLabel><Input id="name" name="name" autoComplete="name" placeholder="怎么称呼你" minLength={1} maxLength={80} required disabled={pending} /></Field>}
      <Field><FieldLabel htmlFor="email">邮箱</FieldLabel><Input id="email" name="email" type="email" autoComplete="email" placeholder="you@example.com" required disabled={pending} /></Field>
      <Field><FieldLabel htmlFor="password">密码</FieldLabel><Input id="password" name="password" type="password" autoComplete={registering ? 'new-password' : 'current-password'} placeholder="至少 8 位字符" minLength={8} maxLength={128} required disabled={pending} /></Field>
    </FieldGroup><Button type="submit" disabled={pending}>{pending ? <Spinner data-icon="inline-start" /> : <ArrowRight data-icon="inline-start" />}{registering ? '创建账号并进入' : '登录工作台'}</Button></form>
    <p className="text-center text-xs text-muted-foreground">{registering ? '已经有账号？' : '还没有账号？'} <Link href={registering ? '/sign-in' : '/sign-up'} className="font-medium text-foreground underline underline-offset-4">{registering ? '去登录' : '创建账号'}</Link></p>
    <p className="text-center text-xs leading-5 text-muted-foreground">这是 Orvilo2 应用账号，与 v0 账号独立；首次使用请先创建账号。<br />数据存储于 Neon · 任务默认私有，可授权成员共同编辑</p>
  </section></main>
}
