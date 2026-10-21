'use client'

import Link from 'next/link'
import { useState, type MouseEvent } from 'react'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'

export function AcceptanceEntry() {
  const [message, setMessage] = useState('预览使用独立的安全会话。如果 Safari 阻止会话，请允许访问后重试，或在新标签页打开。')
  const [pending, setPending] = useState(false)

  async function recoverSession(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault()
    if (pending) return
    setPending(true)
    try {
      if (window.self !== window.top && typeof document.requestStorageAccess === 'function') {
        const allowed = typeof document.hasStorageAccess === 'function' && await document.hasStorageAccess()
        if (!allowed) await document.requestStorageAccess()
      }
      window.location.assign('/api/acceptance')
    } catch {
      setMessage('浏览器未允许内嵌预览使用会话。请点击“在新标签页打开验收”，在独立页面继续，无需关闭 Safari 的隐私保护。')
      setPending(false)
    }
  }

  return <main className="flex min-h-svh items-center justify-center bg-background p-6">
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle><h1>继续验收</h1></CardTitle>
        <CardDescription>未能建立或保留验收会话。无需填写邮箱、密码或进行 GitHub 授权。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <a href="/api/acceptance" onClick={recoverSession} aria-disabled={pending} className="text-sm underline underline-offset-4">{pending ? '正在恢复验收会话…' : '允许预览会话并重试'}</a>
        <a href="/api/acceptance" target="_blank" rel="noopener noreferrer" className="text-sm underline underline-offset-4">在新标签页打开验收</a>
        <p role="status" className="text-sm text-muted-foreground">{message}</p>
      </CardContent>
      <CardFooter className="flex flex-col items-start gap-2">
        <p className="text-xs text-muted-foreground">仅限开发预览。任务与项目真实保存，且与正式账号数据隔离。</p>
        <Link href="/sign-in?login=1" className="text-xs text-muted-foreground underline underline-offset-4">改用自己的账号登录</Link>
      </CardFooter>
    </Card>
  </main>
}
