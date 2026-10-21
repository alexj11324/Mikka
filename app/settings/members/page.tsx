import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'
import { loadWorkspaceSettings } from '@/lib/workspace-access'
import { WorkspaceApp } from '@/components/workspace-app'

export const metadata: Metadata = { title: '成员管理 · Orvilo3', description: '管理工作区成员、角色与邀请，支持 CSV 拖拽批量邀请和成员导出。' }

export default async function MembersPage({ searchParams }: { searchParams: Promise<{ workspace?: string; invite?: string }> }) {
  const query = await searchParams
  const session = await getSession()
  if (!session?.user) redirect('/sign-in?next=%2Fsettings%2Fmembers')
  const initial = await loadWorkspaceSettings(query.workspace).catch(() => null)
  return <WorkspaceApp user={session.user} initialMembers={initial ?? undefined} />
}
