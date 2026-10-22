import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getSession } from '@/lib/session'
import { loadTeamDirectory } from '@/app/actions/teams'
import { WorkspaceApp } from '@/components/workspace-app'

export const metadata: Metadata = { title: '团队管理 · Orvilo3', description: '浏览工作区公开团队，管理团队成员、任务归属与项目关联。' }
export default async function TeamsPage({ searchParams }: { searchParams: Promise<{ workspace?: string; team?: string; create?: string; view?: string }> }) {
  const query = await searchParams
  const session = await getSession()
  if (!session?.user) redirect('/sign-in?next=%2Fsettings%2Fteams')
  const initial = await loadTeamDirectory(query.workspace).catch(() => null)
  return <WorkspaceApp user={session.user} initialTeams={initial ?? undefined} />
}
