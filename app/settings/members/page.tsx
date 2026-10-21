import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { MembersPageView } from '@/components/settings/members-page'

export const metadata: Metadata = { title: '成员管理 · Orvilo3', description: '管理工作区成员、角色与邀请，支持 CSV 拖拽批量邀请和成员导出。' }

export default async function MembersPage({ searchParams }: { searchParams: Promise<{ workspace?: string; invite?: string }> }) {
  const query = await searchParams
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) redirect('/sign-in?next=%2Fsettings%2Fmembers')
  return <MembersPageView user={session.user} workspaceId={query.workspace} inviteInitially={query.invite === '1'} />
}
