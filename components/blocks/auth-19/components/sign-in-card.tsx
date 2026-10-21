'use client'

import type { FormEventHandler } from 'react'
import Link from 'next/link'
import { ArrowRightIcon, Loader2Icon, LockKeyholeIcon, MailIcon, UserIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Separator } from '@/components/ui/separator'
import { GithubDark } from '@/components/ui/svgs/githubDark'
import { GithubLight } from '@/components/ui/svgs/githubLight'

type SignInCardProps = {
  registering: boolean
  pending: boolean
  githubEnabled: boolean
  error: string
  notice: string
  callbackURL?: string
  next?: string
  onSubmit: FormEventHandler<HTMLFormElement>
  onGitHubSignIn: () => Promise<void>
}

export function SignInCard({ registering, pending, githubEnabled, error, notice, callbackURL, next = '/', onSubmit, onGitHubSignIn }: SignInCardProps) {
  return (
    <Card className="w-full max-w-[26rem] overflow-hidden p-0">
      <CardHeader className="px-7 pt-8 pb-5 sm:px-9 sm:pt-9 sm:pb-6">
        <div className="flex flex-col gap-1">
          <CardTitle className="text-2xl font-semibold tracking-tight text-balance">
            <h1>{registering ? '创建你的工作账号' : '欢迎回来'}</h1>
          </CardTitle>
          <CardDescription className="text-pretty">
            {registering ? '从第一个任务开始，把想法变成可追踪的进展。' : '登录 Orvilo2，继续你的任务与文档。'}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-6 px-7 pb-7 sm:px-9 sm:pb-8">
        <div className="flex flex-col gap-3">
          <Button type="button" variant="outline" className="w-full justify-center px-4" disabled={pending || !githubEnabled} onClick={onGitHubSignIn}>
            {pending ? <Loader2Icon aria-hidden="true" className="animate-spin" data-icon="inline-start" /> : <>
              <span aria-hidden="true" className="dark:hidden"><GithubLight className="size-4" /></span>
              <span aria-hidden="true" className="hidden dark:block"><GithubDark className="size-4" /></span>
            </>}
            使用 GitHub 继续
          </Button>
          <p className="text-muted-foreground text-xs leading-5">{githubEnabled ? '仅获取登录所需的身份与邮箱，不请求仓库读写权限。' : 'GitHub 登录暂未配置，请使用邮箱继续。'}</p>
          {!githubEnabled && callbackURL && <details className="text-muted-foreground text-xs"><summary className="cursor-pointer">查看 GitHub App 回调地址</summary><code className="mt-2 block break-all select-all">{callbackURL}</code></details>}
          {notice && <p role="status" className="text-xs leading-5">{notice}</p>}
        </div>
        <div className="flex items-center gap-3">
          <Separator className="flex-1" />
          <span className="text-muted-foreground text-xs">或使用邮箱</span>
          <Separator className="flex-1" />
        </div>
        {error && <p id="auth-error" role="alert" className="text-destructive text-sm">{error}</p>}
        <form method="post" className="flex flex-col gap-5" onSubmit={onSubmit} aria-busy={pending} aria-describedby={error ? 'auth-error' : undefined}>
          <FieldGroup>
            {registering && <Field data-disabled={pending} className="gap-2">
              <FieldLabel htmlFor="name">称呼</FieldLabel>
              <InputGroup>
                <InputGroupAddon><UserIcon aria-hidden="true" /></InputGroupAddon>
                <InputGroupInput id="name" name="name" autoComplete="name" placeholder="怎么称呼你" minLength={1} maxLength={80} required disabled={pending} />
              </InputGroup>
            </Field>}
            <Field data-disabled={pending} className="gap-2">
              <FieldLabel htmlFor="email">邮箱</FieldLabel>
              <InputGroup>
                <InputGroupAddon><MailIcon aria-hidden="true" /></InputGroupAddon>
                <InputGroupInput id="email" name="email" type="email" autoComplete="email" placeholder="you@example.com" required disabled={pending} />
              </InputGroup>
            </Field>
            <Field data-disabled={pending} className="gap-2">
              <FieldLabel htmlFor="password">密码</FieldLabel>
              <InputGroup>
                <InputGroupAddon><LockKeyholeIcon aria-hidden="true" /></InputGroupAddon>
                <InputGroupInput id="password" name="password" type="password" autoComplete={registering ? 'new-password' : 'current-password'} placeholder="至少 8 位字符" minLength={8} maxLength={128} required disabled={pending} />
              </InputGroup>
            </Field>
          </FieldGroup>
          <Button type="submit" className="w-full" disabled={pending}>
            {registering ? '创建账号并进入' : '登录工作台'}
            {pending ? <Loader2Icon aria-hidden="true" className="animate-spin" data-icon="inline-end" /> : <ArrowRightIcon aria-hidden="true" data-icon="inline-end" />}
          </Button>
        </form>
        <p className="text-muted-foreground text-center text-xs">
          {registering ? '已经有账号？' : '还没有账号？'}{' '}
          <Link href={`${registering ? '/sign-in' : '/sign-up'}?next=${encodeURIComponent(next)}`} className="text-foreground underline underline-offset-4">{registering ? '去登录' : '创建账号'}</Link>
        </p>
      </CardContent>
    </Card>
  )
}
