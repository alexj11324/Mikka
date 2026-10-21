'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Loader2, Users } from 'lucide-react'
import { acceptWorkspaceInvitation } from '@/app/actions/workspace'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button, buttonVariants } from '@/components/ui/button'
import { authClient } from '@/lib/auth-client'

export function InvitationCard({ token, email }: { token: string; email: string | null }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const next = `/invite/${token}`
  async function accept() {
    if (pending) return
    setPending(true); setError('')
    try {
      const result = await acceptWorkspaceInvitation(token)
      if (!result.ok) { setError(result.error); return }
      window.location.assign(`/settings/members?workspace=${result.data.workspaceId}`)
    } catch { setError('暂时无法接受邀请，请稍后重试。') }
    finally { setPending(false) }
  }
  async function switchAccount() {
    setPending(true)
    try { await authClient.signOut(); window.location.assign(`/sign-in?next=${encodeURIComponent(next)}`) }
    catch { setError('退出失败，请重试。'); setPending(false) }
  }
  return <Card className="w-full max-w-md"><CardHeader><Users className="mb-2" /><CardTitle>加入工作区</CardTitle><CardDescription>你收到了一份 Orvilo3 工作区邀请。请使用受邀邮箱登录，确认后加入。</CardDescription></CardHeader><CardContent className="flex flex-col gap-4">{!token ? <Alert variant="destructive"><AlertDescription>邀请链接格式无效，请向管理员索取完整链接。</AlertDescription></Alert> : email ? <p className="break-all text-sm text-muted-foreground">当前登录：{email}</p> : <p className="text-sm text-muted-foreground">邀请链接有效期为 7 天，仅限对应的受邀邮箱使用。</p>}{error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}</CardContent><CardFooter className="flex flex-col gap-3">{token && (email ? <><Button className="w-full" disabled={pending} onClick={() => void accept()}>{pending && <Loader2 className="animate-spin" data-icon="inline-start" />}接受邀请并加入</Button><Button variant="ghost" disabled={pending} onClick={() => void switchAccount()}>切换账号</Button></> : <><Link href={`/sign-in?next=${encodeURIComponent(next)}`} className={buttonVariants({ className: 'w-full' })}>登录并接受邀请</Link><Link href={`/sign-up?next=${encodeURIComponent(next)}`} className={buttonVariants({ variant: 'outline', className: 'w-full' })}>创建账号</Link></>)}<Link href="/" className="text-sm text-muted-foreground underline underline-offset-4">返回工作台</Link></CardFooter></Card>
}
