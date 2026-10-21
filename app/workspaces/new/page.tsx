import type { Metadata } from 'next'
import Link from 'next/link'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { auth } from '@/lib/auth'
import { buttonVariants } from '@/components/ui/button'
import { CreateWorkspaceForm } from '@/components/workspace/create-workspace-form'

export const metadata: Metadata = { title: '创建工作区 · Orvilo3', description: '创建新的 Orvilo3 工作区，设置名称与专属网址，邀请团队协作。', robots: { index: false, follow: false } }

export default async function NewWorkspacePage() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/sign-in?next=%2Fworkspaces%2Fnew')
  return <div className="flex min-h-dvh flex-col bg-background">
    <header className="flex items-center justify-between gap-4 px-4 py-5 sm:px-8">
      <Link href="/" className={buttonVariants({ variant: 'ghost', size: 'sm' })}><ArrowLeft data-icon="inline-start" />返回</Link>
      <span className="max-w-[60%] truncate text-xs text-muted-foreground" title={session.user.email}>{session.user.email}</span>
    </header>
    <main className="mx-auto flex w-full max-w-lg flex-1 flex-col px-6 pt-12 pb-16 sm:pt-24">
      <div className="mb-10 flex flex-col gap-3"><h1 className="text-3xl font-semibold tracking-tight">创建新的工作区</h1><p className="text-sm leading-relaxed text-muted-foreground">工作区是团队的协作空间，让项目、任务和成员汇集于此。</p></div>
      <CreateWorkspaceForm />
    </main>
  </div>
}
