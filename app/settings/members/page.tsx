import type { Metadata } from 'next'
import Link from 'next/link'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { loadWorkspaceSettings } from '@/lib/workspace-access'
import { MembersSettings } from '@/components/workspace/members-settings'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

export const metadata: Metadata = { title: '成员管理 · Orvilo3', description: '管理工作区成员、角色与邀请，支持 CSV 拖拽批量邀请和成员导出。' }

export default async function MembersPage({ searchParams }: { searchParams: Promise<{ workspace?: string; invite?: string }> }) {
  const query = await searchParams
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/sign-in?next=%2Fsettings%2Fmembers')
  const initial = await loadWorkspaceSettings(query.workspace).catch(() => null)
  if (!initial) return <main className="mx-auto flex max-w-lg flex-col gap-6 p-8"><Alert variant="destructive"><AlertTitle>无法访问此工作区</AlertTitle><AlertDescription>你可能已被停用，或没有查看此工作区的权限。</AlertDescription></Alert><Link href="/settings/members" className="underline underline-offset-4">返回可访问的工作区</Link></main>
  return <MembersSettings initial={initial} inviteInitially={query.invite === '1'} />
}
