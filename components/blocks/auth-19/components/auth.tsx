import type { ReactNode } from 'react'
import Link from 'next/link'
import { buttonVariants } from '@/components/ui/button'
import { AuthLogo } from './auth-logo'

export function Auth({ registering = false, children, next = '/' }: { registering?: boolean; children: ReactNode; next?: string }) {
  return (
    <main className="bg-background text-foreground flex min-h-svh w-full flex-col">
      <header className="flex items-center justify-between gap-4 px-5 py-5 sm:px-8 sm:py-6 lg:px-10">
        <AuthLogo />
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground hidden sm:inline">{registering ? '已经有账号？' : '还没有工作账号？'}</span>
          <Link href={`${registering ? '/sign-in' : '/sign-up'}?next=${encodeURIComponent(next)}`} className={buttonVariants({ variant: 'link' })}>
            {registering ? '去登录' : '创建账号'}
          </Link>
        </div>
      </header>
      <section aria-label={registering ? '注册账号' : '登录账号'} className="flex flex-1 items-center justify-center px-5 py-10 sm:px-8 sm:py-16">
        <div className="flex w-full flex-col items-center gap-6">
          {children}
          <footer className="text-muted-foreground flex max-w-[26rem] flex-col items-center gap-2 text-center text-xs leading-5 text-pretty">
            <p>任务与文档，保持同步。</p>
            <p>这是 Orvilo2 应用账号，与 v0 账号独立。<br />数据存储于 Neon · 任务默认私有</p>
          </footer>
        </div>
      </section>
    </main>
  )
}
